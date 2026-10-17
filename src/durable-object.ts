// 一条 WebSocket = 一个 Durable Object 实例。
//
// 页面上所有标签共用这一条连接：每个终端标签占一路 PTY 通道，每个文件管理标签占一路
// SFTP 通道，批量执行的每一台机器占一路 exec 通道。DO 只做三件事：
//   1. 通道表 —— 浏览器侧通道号 ↔ 一条 SSH 连接；
//   2. 分发 —— 控制帧按动词走，数据帧按通道号投；
//   3. 串行化 —— 同一通道上的数据帧与动词排成一条链，顺序不会乱。
//
// 两类连接的生命周期**不一致**，这是本文件最需要注意的一点：
//   · sftp / exec 绑在通道上（关通道即关连接）；
//   · pty 绑在 session_id 上，WS 断开后还活 60 秒，供前端重连接回同一个 shell。
//
// 凭据只在 open 请求里经过一下：认证一结束就从内存里抹掉，不落任何存储。

import type { Env } from './types';
import {
  PROTOCOL_VERSION,
  decodeEnvelope,
  decodeFrame,
  encodeFrame,
  requireChan,
  requirePath,
  type ApiNode,
  type Envelope,
} from './protocol';
import {
  ExecHandler,
  PTYHandler,
  SFTPHandler,
  SSHConnection,
  describeConnectFailure,
  type ChannelCallbacks,
} from './session';
import { TerminalSession, nodeKeyOf, type TerminalSink } from './sessions';
import { dialNode } from './dial';
import { clampCols, clampRows, validateNode } from './node';
import { deferred, messageOf, withTimeout } from './util';
import { elapsedMs, logError, logInfo, logWarn } from './log';

interface ChannelEntry {
  chan: number;
  kind: 'pty' | 'exec' | 'sftp';
  conn: SSHConnection;
  /** SSH 层的本地通道号（关通道时要用）。 */
  localId: number;
  pty?: PTYHandler;
  exec?: ExecHandler;
  sftp?: SFTPHandler;
  /** pty 通道才有：会话对象（跨 WS 存活）。 */
  terminal?: TerminalSession;
  /** 本通道上的任务链：数据帧与控制动词按到达顺序串行执行。 */
  chain: Promise<void>;
}

/** 一次握手的总预算：TCP + 版本交换 + 密钥协商 + 认证。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * 单条 WebSocket 上最多几路通道。
 *
 * 每路通道都是一条独立 SSH 连接（握手 + keepalive），而一个 isolate 能同时持有的
 * 连接数是有限的。不设上限的话，一个客户端开几十个标签就能把额度吃光，
 * 别的连接连握手都排不上——症状是「只有他一个人能用」。
 */
const MAX_CHANNELS = 16;

export class ManagiSessionDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly channels = new Map<number, ChannelEntry>();
  /** pty 会话：跨 WS 存活，按 session_id 索引。 */
  private readonly terminals = new Map<string, TerminalSession>();
  /** 绑在通道上的连接（sftp / exec）：WS 一断就收掉。 */
  private readonly transient = new Set<SSHConnection>();
  private nextChan = 0;
  /** 正在握手、还没进通道表的 open 数：限流要连它们一起算，否则并发 open 能绕过上限。 */
  private opening = 0;
  /** 当前这条 WS。一条连接 = 一个 DO 实例，但同一实例会被重连复用（见 worker.ts 的 client_id）。 */
  private activeWs: WebSocket | null = null;
  private closed = true;
  private rejectShutdown: ((error: Error) => void) | null = null;
  private shutdown!: Promise<never>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.resetShutdown();
    // 实例重启（休眠 / 换机）：内存里的 SSH 状态已经没了，只能让前端重连。
    for (const ws of state.getWebSockets()) {
      try { ws.close(1012, 'Worker 会话已重启，请重新连接'); } catch { /* 已关闭 */ }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/connect') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    // 一个 DO 同一时刻只服务一条 WS：重连时把旧的掐掉，状态从这一条重新开始。
    // 旧 socket 上还没了结的握手由各自的闭包兜住（写不出去就丢弃），不会污染新连接。
    for (const stale of this.state.getWebSockets()) {
      try { stale.close(1012, '新连接接管'); } catch { /* 已关闭 */ }
    }
    this.channels.clear();
    this.transient.clear();
    this.closed = false;
    this.resetShutdown();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.activeWs = server;
    this.state.acceptWebSocket(server);
    // 连上就报身份：前端据此判断「服务端是不是我认得的这一版」，
    // 把「部署了新后端、页面还是旧缓存」从灵异事件变成一句可读的错误。
    this.sendControl(server, 'hello', {
      protocol: PROTOCOL_VERSION,
      backend: 'worker',
      limits: {
        max_channels: MAX_CHANNELS,
        max_file_bytes: SFTPHandler.MAX_FILE_BYTES,
        max_list_entries: SFTPHandler.MAX_LIST_ENTRIES,
        max_remove_depth: SFTPHandler.MAX_REMOVE_DEPTH,
        max_exec_output: ExecHandler.MAX_STREAM_BYTES,
        pty_idle_ttl_ms: TerminalSession.IDLE_TTL_MS,
      },
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private resetShutdown(): void {
    this.shutdown = new Promise<never>((_, reject) => { this.rejectShutdown = reject; });
    this.shutdown.catch(() => undefined);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.closed || ws !== this.activeWs) return;
    if (typeof message === 'string') {
      const envelope = decodeEnvelope(message);
      if (!envelope) {
        this.sendError(ws, 0, 0, '控制帧不是合法 JSON');
        return;
      }
      await this.handleControl(ws, envelope);
      return;
    }
    this.handleBinary(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.settle(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.settle(ws);
  }

  /**
   * settle 收尾一条 WS 连接。
   *
   * 与以前的区别只有一处，但很关键：**pty 会话不在这里关**。
   * 它们改成 detach + 空闲计时，让网络抖动不至于把用户正在跑的东西全部清空。
   */
  private settle(ws?: WebSocket): void {
    if (ws && ws !== this.activeWs) return; // 旧 socket 迟到的关闭通知
    if (this.closed) return;
    if (this.channels.size > 0) {
      logInfo('do.close', {
        channels: this.channels.size,
        terminals: this.terminals.size,
        transient: this.transient.size,
      });
    }
    this.closed = true;
    this.activeWs = null;
    this.rejectShutdown?.(new Error('连接已断开'));
    this.rejectShutdown = null;
    for (const entry of this.channels.values()) {
      if (entry.kind === 'pty') entry.terminal?.detach();
    }
    for (const conn of [...this.transient]) {
      try { conn.close(); } catch { /* 已关闭 */ }
    }
    this.transient.clear();
    this.channels.clear();
  }

  // ===== 控制面 =====

  private async handleControl(ws: WebSocket, message: Envelope): Promise<void> {
    const seq = typeof message.seq === 'number' ? message.seq : 0;
    switch (message.type) {
      case 'ping':
        this.sendControl(ws, 'pong', undefined, seq);
        return;
      case 'open':
        await this.handleOpen(ws, message);
        return;
      case 'close':
        this.handleClose(message);
        return;
      case 'resize':
        this.handleResize(message);
        return;
      case 'ls':
        this.runSFTP(ws, message, async (entry) => {
          const path = requirePath(message.data, 'ls');
          const result = await entry.sftp!.list(path);
          this.sendControl(ws, 'ls', {
            chan: entry.chan,
            path: result.path,
            // 空目录省略 files：没有条目就是没有，与后端契约一致。
            ...(result.files.length > 0 ? { files: result.files } : {}),
            // 被上限截断时必须说出来：前端据此提示「只显示了一部分」，
            // 否则用户会以为目录里就这么多东西。
            ...(result.truncated ? { truncated: true } : {}),
          }, seq);
        });
        return;
      case 'mkdir':
        this.runSFTP(ws, message, async (entry) => {
          const path = requirePath(message.data, 'mkdir');
          await entry.sftp!.mkdir(path);
          this.sendControl(ws, 'mkdir', { chan: entry.chan, path }, seq);
        });
        return;
      case 'rm':
        this.runSFTP(ws, message, async (entry) => {
          const path = requirePath(message.data, 'rm');
          await entry.sftp!.remove(path);
          this.sendControl(ws, 'rm', { chan: entry.chan, path }, seq);
        });
        return;
      case 'upload':
        this.runSFTP(ws, message, async (entry) => {
          const data = (message.data ?? {}) as { path?: unknown; filename?: unknown; size?: unknown; mtime?: unknown };
          const dir = typeof data.path === 'string' ? data.path : '';
          if (typeof data.filename !== 'string' || data.filename === '') throw new Error('upload: filename 必填');
          const size = typeof data.size === 'number' && Number.isFinite(data.size) ? data.size : 0;
          const mtime = typeof data.mtime === 'number' && Number.isFinite(data.mtime) ? data.mtime : 0;
          const result = await entry.sftp!.beginUpload(dir, data.filename, size, mtime);
          this.sendControl(ws, 'upload', {
            chan: entry.chan,
            offset: result.offset,
            chunk_size: result.chunk_size,
          }, seq);
        });
        return;
      case 'download':
        this.runSFTP(ws, message, async (entry) => {
          const path = requirePath(message.data, 'download');
          const result = await entry.sftp!.download(path);
          this.sendControl(ws, 'download', {
            chan: entry.chan,
            filename: result.filename,
            total: result.total,
          }, seq);
          // 响应先出、数据后走：顺序反了前端就不知道这堆字节属于哪次请求。
          result.start();
        });
        return;
      default:
        this.sendError(ws, 0, seq, `未知动词：${message.type}`);
    }
  }

  private handleBinary(ws: WebSocket, buffer: ArrayBuffer): void {
    const frame = decodeFrame(buffer);
    if (!frame) {
      // 连帧头都解不出来 = 字节流已错位，继续留在错位上只会产出坏文件。
      this.sendError(ws, 0, 0, '数据帧帧头不完整');
      try { ws.close(1003, 'Malformed data frame'); } catch { /* 已关闭 */ }
      return;
    }
    const entry = this.channels.get(frame.chan);
    if (!entry) return; // 通道可能刚被关掉：静默丢弃，报错只会刷屏
    if (entry.kind === 'pty') {
      entry.pty?.queueInput(frame.payload);
      return;
    }
    if (entry.kind === 'exec') {
      // exec 没有 stdin：静默丢弃会让调用方以为输入生效了。
      this.sendError(ws, entry.chan, 0, 'exec 通道不接受输入');
      return;
    }
    this.enqueue(ws, entry, async () => {
      const handler = entry.sftp;
      if (!handler) throw new Error('SFTP 会话不可用');
      if (frame.payload.byteLength > 0) await handler.writeData(frame.payload);
      if (!frame.end) return;
      const size = await handler.finishUpload();
      this.sendControl(ws, 'upload_end', { chan: entry.chan, size });
    });
  }

  private handleResize(message: Envelope): void {
    let chan: number;
    try {
      chan = requireChan(message.data);
    } catch {
      return; // resize 是 seq=0 的自愈提示，不值得打断对端
    }
    const entry = this.channels.get(chan);
    if (!entry || entry.kind !== 'pty') return;
    const data = (message.data ?? {}) as { cols?: unknown; rows?: unknown };
    if (typeof data.cols !== 'number' || typeof data.rows !== 'number') return;
    entry.conn.resizePTY(entry.localId, data.cols, data.rows);
  }

  private handleClose(message: Envelope): void {
    let chan: number;
    try {
      chan = requireChan(message.data);
    } catch {
      return;
    }
    const entry = this.channels.get(chan);
    if (!entry) return;
    this.channels.delete(chan);
    if (entry.kind === 'pty') {
      // shell 留着：TTL 内重开同一 session_id 还能接回来。
      entry.terminal?.detach();
      return;
    }
    this.transient.delete(entry.conn);
    entry.conn.closeChannel(entry.localId);
  }

  // ===== open =====

  private async handleOpen(ws: WebSocket, message: Envelope): Promise<void> {
    const seq = typeof message.seq === 'number' ? message.seq : 0;
    const data = (message.data ?? {}) as {
      kind?: unknown;
      node?: ApiNode;
      cols?: unknown;
      rows?: unknown;
      command?: unknown;
      session_id?: unknown;
    };
    if (data.kind !== 'pty' && data.kind !== 'exec' && data.kind !== 'sftp') {
      this.sendError(ws, 0, seq, `open: kind 必须是 "pty" / "exec" / "sftp"，收到 ${String(data.kind)}`);
      return;
    }
    const kind = data.kind;
    try {
      validateNode(data.node);
    } catch (error) {
      this.sendError(ws, 0, seq, `open: ${messageOf(error)}`);
      return;
    }
    const target = data.node!;

    // 上限按「已建好的 + 正在握手的」一起算：只看通道表的话，
    // 一口气发 20 个 open（都还在握手、都还没进表）就能全部通过检查。
    if (this.channels.size + this.opening >= MAX_CHANNELS) {
      this.sendError(ws, 0, seq, `通道数已达上限（${MAX_CHANNELS} 个），请先关闭一个标签`);
      return;
    }
    this.opening += 1;
    const chan = ++this.nextChan;
    try {
      if (kind === 'pty') await this.openPTY(ws, seq, chan, target, data);
      else if (kind === 'exec') await this.openExec(ws, seq, chan, target, data);
      else await this.openSFTP(ws, seq, chan, target);
    } finally {
      // 成功与失败都要还回去；漏掉任何一个分支，上限就会随失败次数越收越紧。
      this.opening -= 1;
    }
  }

  private async openPTY(
    ws: WebSocket,
    seq: number,
    chan: number,
    target: ApiNode,
    data: { cols?: unknown; rows?: unknown; session_id?: unknown },
  ): Promise<void> {
    const startedAt = Date.now();
    const key = nodeKeyOf(target);
    const sessionId = typeof data.session_id === 'string' ? data.session_id.trim().slice(0, 128) : '';

    // ① 先看能不能接回一个还活着的会话。这一条是 Worker 版稳定性的核心：
    //    浏览器换了网络、标签切回来、笔记本合盖醒来，用户看到的应当还是那个 shell。
    if (sessionId) {
      const existing = this.terminals.get(sessionId);
      if (existing) {
        if (existing.isDisposed) {
          this.terminals.delete(sessionId);
        } else if (existing.key !== key) {
          this.sendError(ws, chan, seq,
            `session_id 已属于另一节点，会话不能跨节点复用；请新开一个标签`);
          return;
        } else {
          const sink = this.sinkFor(ws, chan);
          this.channels.set(chan, {
            chan, kind: 'pty', conn: existing.connection, localId: existing.localId,
            terminal: existing, chain: Promise.resolve(),
          });
          existing.attach(sink);
          this.sendControl(ws, 'open', {
            kind: 'pty', chan, reattached: true,
            chunk_size: PTYHandler.IN_FRAME, window: PTYHandler.WINDOW,
          }, seq);
          // 响应已写出，现在才回放 scrollback 并开闸：顺序反了前端会先收到
          // 一批还不认识 chan 的字节（被丢掉的正是「我刚跑的命令输出」）。
          existing.release();
          logInfo('do.reattach', { chan, host: target.host, port: target.port, ms: elapsedMs(startedAt) });
          return;
        }
      }
    }

    let settled = false;
    const opened = deferred<string | undefined>();
    opened.promise.catch(() => undefined);
    let conn: SSHConnection | null = null;
    try {
      conn = await dialNode(this.env, target, {
        cols: data.cols,
        rows: data.rows,
        onEnded: (error) => {
          if (settled) {
            this.sendError(ws, chan, 0, error.message);
            return;
          }
          settled = true;
          if (!this.closed) this.sendError(ws, 0, seq, describeConnectFailure(error, target.host, target.port));
        },
      });
      const connection = conn;
      const session = new TerminalSession(
        sessionId || `${key}#${chan}`,
        key,
        connection,
        (gone) => {
          if (this.terminals.get(gone.id) === gone) this.terminals.delete(gone.id);
        },
      );
      this.terminals.set(session.id, session);

      const prepared = (async () => {
        await withTimeout(connection.handshake(), HANDSHAKE_TIMEOUT_MS, 'SSH 握手超时');
        // 握手期间可能已经换了新连接：旧 socket 上的一切都该停在这里。
        if (this.activeWs !== ws) {
          connection.close();
          throw new Error('连接已被新会话接管');
        }
        const pty = new PTYHandler(connection, clampCols(data.cols), clampRows(data.rows), {
          data: (payload, end) => session.push(payload, end),
          control: (envelope) => session.notify(envelope),
          error: (message) => session.fail(message),
          ready: (info) => opened.resolve(info),
          failed: (message) => opened.reject(new Error(message)),
        });
        session.localId = connection.openPTY(pty);
        session.attach(this.sinkFor(ws, chan));
        this.channels.set(chan, {
          chan, kind: 'pty', conn: connection, localId: session.localId,
          pty, terminal: session, chain: Promise.resolve(),
        });
        return opened.promise;
      })();

      await Promise.race([prepared, this.shutdown]);
      // 通道已就绪：往后再断开就是通道自己的事，不该再回填 open 的 seq。
      settled = true;
      if (this.closed) return;
      this.sendControl(ws, 'open', {
        kind: 'pty', chan, chunk_size: PTYHandler.IN_FRAME, window: PTYHandler.WINDOW,
      }, seq);
      session.release();
      logInfo('do.open.ok', { kind: 'pty', chan, host: target.host, port: target.port, ms: elapsedMs(startedAt) });
    } catch (error) {
      this.channels.delete(chan);
      if (sessionId) {
        const dead = this.terminals.get(sessionId);
        if (dead && dead.connection === conn) this.terminals.delete(sessionId);
      }
      if (conn) {
        try { conn.close(); } catch { /* 已关闭 */ }
      }
      if (settled) return; // ended 回调已经把这次失败说清楚了
      logError('do.open.fail', {
        kind: 'pty', host: target.host, port: target.port, ms: elapsedMs(startedAt), reason: messageOf(error),
      });
      settled = true;
      if (this.closed) return;
      this.sendError(ws, 0, seq, describeConnectFailure(error, target.host, target.port));
    }
  }

  private async openExec(
    ws: WebSocket,
    seq: number,
    chan: number,
    target: ApiNode,
    data: { command?: unknown },
  ): Promise<void> {
    const startedAt = Date.now();
    const command = typeof data.command === 'string' ? data.command : '';
    if (command === '') {
      this.sendError(ws, 0, seq, 'open: exec 需要 command');
      return;
    }
    // 4096 与 SSH 通道请求的实际上限对齐；换行会被远端 shell 当成第二条命令，
    // 而「一台机器上跑多条命令」是前端自己拼 `&&` 的事，不该悄悄发生在这里。
    if (command.length > 4096 || /[\0\r\n]/.test(command)) {
      this.sendError(ws, 0, seq, 'open: command 必须是单行且不超过 4096 字符');
      return;
    }

    let settled = false;
    const opened = deferred<string | undefined>();
    opened.promise.catch(() => undefined);
    let conn: SSHConnection | null = null;
    try {
      conn = await dialNode(this.env, target, {
        onEnded: (error) => {
          if (settled) {
            this.sendError(ws, chan, 0, error.message);
            return;
          }
          settled = true;
          if (!this.closed) this.sendError(ws, 0, seq, describeConnectFailure(error, target.host, target.port));
        },
      });
      this.transient.add(conn);
      const connection = conn;

      let exec: ExecHandler | null = null;
      const callbacks: ChannelCallbacks = {
        data: (payload, end, stderr) => this.sendData(ws, chan, payload, end, stderr),
        control: (envelope) => this.sendControl(ws, envelope.type, { chan, ...(envelope.data as object | undefined) }),
        error: (message) => this.sendError(ws, chan, 0, message),
        ready: (info) => opened.resolve(info),
        failed: (message) => opened.reject(new Error(message)),
      };

      const prepared = (async () => {
        await withTimeout(connection.handshake(), HANDSHAKE_TIMEOUT_MS, 'SSH 握手超时');
        if (this.activeWs !== ws) {
          connection.close();
          throw new Error('连接已被新会话接管');
        }
        exec = new ExecHandler(connection, command, callbacks);
        const localId = connection.openExec(exec);
        this.channels.set(chan, {
          chan, kind: 'exec', conn: connection, localId, exec, chain: Promise.resolve(),
        });
        return opened.promise;
      })();

      await Promise.race([prepared, this.shutdown]);
      settled = true;
      if (this.closed) return;
      this.sendControl(ws, 'open', { kind: 'exec', chan }, seq);
      // 响应之后才放输出：exec 的第一片常常和 CHANNEL_SUCCESS 挤在同一个 TCP 段里。
      exec!.start();
      logInfo('do.open.ok', { kind: 'exec', chan, host: target.host, port: target.port, ms: elapsedMs(startedAt) });
    } catch (error) {
      this.channels.delete(chan);
      if (conn) {
        this.transient.delete(conn);
        try { conn.close(); } catch { /* 已关闭 */ }
      }
      if (settled) return;
      logError('do.open.fail', {
        kind: 'exec', host: target.host, port: target.port, ms: elapsedMs(startedAt), reason: messageOf(error),
      });
      settled = true;
      if (this.closed) return;
      this.sendError(ws, 0, seq, describeConnectFailure(error, target.host, target.port));
    }
  }

  private async openSFTP(ws: WebSocket, seq: number, chan: number, target: ApiNode): Promise<void> {
    const startedAt = Date.now();
    let settled = false;
    const opened = deferred<string | undefined>();
    opened.promise.catch(() => undefined);
    let conn: SSHConnection | null = null;
    try {
      conn = await dialNode(this.env, target, {
        onEnded: (error) => {
          if (settled) {
            this.sendError(ws, chan, 0, error.message);
            return;
          }
          settled = true;
          if (!this.closed) this.sendError(ws, 0, seq, describeConnectFailure(error, target.host, target.port));
        },
      });
      this.transient.add(conn);
      const connection = conn;

      const prepared = (async () => {
        await withTimeout(connection.handshake(), HANDSHAKE_TIMEOUT_MS, 'SSH 握手超时');
        if (this.activeWs !== ws) {
          connection.close();
          throw new Error('连接已被新会话接管');
        }
        const sftp = new SFTPHandler(connection, {
          data: (payload, end) => this.sendData(ws, chan, payload, end),
          control: (envelope) => this.sendControl(ws, envelope.type, { chan, ...(envelope.data as object | undefined) }),
          error: (message) => this.sendError(ws, chan, 0, message),
          ready: (info) => opened.resolve(info),
          failed: (message) => opened.reject(new Error(message)),
        });
        const localId = connection.openSFTP(sftp);
        this.channels.set(chan, {
          chan, kind: 'sftp', conn: connection, localId, sftp, chain: Promise.resolve(),
        });
        return opened.promise;
      })();

      const home = await Promise.race([prepared, this.shutdown]);
      settled = true;
      if (this.closed) return;
      const hostKey = connection.getHostKeyInfo();
      this.sendControl(ws, 'open', {
        kind: 'sftp',
        chan,
        ...(home ? { home } : {}),
        window: SFTPHandler.WINDOW,
        // 首连信任（TOFU）要能被看见：指纹随 open 回给前端，由它提示一次。
        ...(hostKey ? { host_key: hostKey } : {}),
      }, seq);
      logInfo('do.open.ok', { kind: 'sftp', chan, host: target.host, port: target.port, ms: elapsedMs(startedAt) });
    } catch (error) {
      this.channels.delete(chan);
      if (conn) {
        this.transient.delete(conn);
        try { conn.close(); } catch { /* 已关闭 */ }
      }
      if (settled) return;
      logError('do.open.fail', {
        kind: 'sftp', host: target.host, port: target.port, ms: elapsedMs(startedAt), reason: messageOf(error),
      });
      settled = true;
      if (this.closed) return;
      this.sendError(ws, 0, seq, describeConnectFailure(error, target.host, target.port));
    }
  }

  // ===== 分发与出站 =====

  private runSFTP(ws: WebSocket, message: Envelope, run: (entry: ChannelEntry) => Promise<void>): void {
    const seq = typeof message.seq === 'number' ? message.seq : 0;
    let chan: number;
    try {
      chan = requireChan(message.data);
    } catch (error) {
      this.sendError(ws, 0, seq, messageOf(error));
      return;
    }
    const entry = this.channels.get(chan);
    if (!entry) {
      this.sendError(ws, chan, seq, `未知通道 ${chan}`);
      return;
    }
    if (entry.kind !== 'sftp') {
      this.sendError(ws, chan, seq, `${message.type}: 这不是 SFTP 通道`);
      return;
    }
    this.enqueue(ws, entry, () => run(entry));
  }

  /** enqueue 把任务挂到通道的任务链上：同一通道的帧与动词严格按到达顺序执行。 */
  private enqueue(ws: WebSocket, entry: ChannelEntry, task: () => Promise<void>): void {
    entry.chain = entry.chain.then(task).catch((error) => {
      if (this.closed) return;
      this.sendError(ws, entry.chan, 0, messageOf(error));
    });
  }

  /** sinkFor 造一个绑在当前连接上的出口：pty 会话重连后换的就是它。 */
  private sinkFor(ws: WebSocket, chan: number): TerminalSink {
    return {
      chan,
      data: (payload, end) => this.sendData(ws, chan, payload, end),
      control: (envelope) => this.sendControl(ws, envelope.type, { chan, ...(envelope.data as object | undefined) }),
      error: (message) => this.sendError(ws, chan, 0, message),
    };
  }

  private sendControl(ws: WebSocket, type: string, data?: unknown, seq?: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const envelope: Envelope = { type };
    if (data !== undefined) envelope.data = data;
    if (seq && seq > 0) envelope.seq = seq;
    try { ws.send(JSON.stringify(envelope)); } catch { /* 连接已断 */ }
  }

  private sendError(ws: WebSocket, chan: number, seq: number, message: string): void {
    this.sendControl(ws, 'error', chan > 0 ? { chan, message } : { message }, seq);
  }

  private sendData(ws: WebSocket, chan: number, payload: Uint8Array, end?: boolean, stderr?: boolean): void {
    if (this.closed) return;
    if (ws.readyState !== WebSocket.OPEN) {
      this.dropChannel(chan, 'ws 已关闭');
      return;
    }
    try {
      ws.send(encodeFrame(chan, payload, end ?? false, stderr ?? false));
    } catch (error) {
      // 写不出去就是这条通道的数据已经丢了。**不能静默**：终端会半个字符地错位、
      // 下载会少一截，而用户看到的是「一切正常」。宁可断开并说清楚。
      this.dropChannel(chan, messageOf(error));
    }
  }

  /** dropChannel 放弃一条通道：断开它的 SSH 连接，往后不再往里读数据。 */
  private dropChannel(chan: number, reason: string): void {
    const entry = this.channels.get(chan);
    if (!entry) return;
    logWarn('ws.send.fail', { chan, kind: entry.kind, reason });
    this.channels.delete(chan);
      if (entry.kind === 'pty') {
        // 挂掉的只是这条 WS 的这一路：shell 还能被重连接回来，别顺手杀掉。
        entry.terminal?.detach();
        return;
      }
    this.transient.delete(entry.conn);
    try { entry.conn.close(); } catch { /* 已关闭 */ }
  }
}
