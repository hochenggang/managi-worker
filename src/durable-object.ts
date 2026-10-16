// 一条 WebSocket = 一个 Durable Object 实例。
//
// 页面上所有标签共用这一条连接：每个终端标签占一路 PTY 通道，每个文件管理标签占一路
// SFTP 通道。DO 只做三件事：
//   1. 通道表 —— 浏览器侧通道号 ↔ 一条独立 SSH 连接；
//   2. 分发 —— 控制帧按动词走，数据帧按通道号投；
//   3. 串行化 —— 同一通道上的数据帧与动词排成一条链，顺序不会乱。
//
// 凭据只在 open 请求里经过一下：认证一结束就从内存里抹掉，不落任何存储。

import type { Env } from './types';
import {
  decodeEnvelope,
  decodeFrame,
  encodeFrame,
  requireChan,
  requirePath,
  type ApiNode,
  type Envelope,
} from './protocol';
import {
  PTYHandler,
  SFTPHandler,
  SSHConnection,
  describeConnectFailure,
  type ChannelCallbacks,
} from './session';
import { dialNode } from './dial';
import { clampCols, clampRows, validateNode } from './node';
import { deferred, messageOf, withTimeout } from './util';

interface ChannelEntry {
  chan: number;
  kind: 'pty' | 'sftp';
  conn: SSHConnection;
  /** SSH 层的本地通道号（关通道时要用）。 */
  localId: number;
  pty?: PTYHandler;
  sftp?: SFTPHandler;
  /** 本通道上的任务链：数据帧与控制动词按到达顺序串行执行。 */
  chain: Promise<void>;
}

/** 一次握手的总预算：TCP + 版本交换 + 密钥协商 + 认证。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

export class ManagiSessionDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly channels = new Map<number, ChannelEntry>();
  /** 所有已建立（含正在握手）的 SSH 连接：WS 一断就全部收掉。 */
  private readonly connections = new Set<SSHConnection>();
  private nextChan = 0;
  private closed = false;
  private rejectShutdown: ((error: Error) => void) | null = null;
  private readonly shutdown: Promise<never>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.shutdown = new Promise<never>((_, reject) => { this.rejectShutdown = reject; });
    this.shutdown.catch(() => undefined);
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
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.closed) return;
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

  async webSocketClose(): Promise<void> {
    this.settle();
  }

  async webSocketError(): Promise<void> {
    this.settle();
  }

  private settle(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectShutdown?.(new Error('连接已断开'));
    this.rejectShutdown = null;
    for (const conn of [...this.connections]) {
      try { conn.close(); } catch { /* 已关闭 */ }
    }
    this.connections.clear();
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
    this.connections.delete(entry.conn);
    // 一路通道一条连接：通道关掉，连接跟着关。
    entry.conn.closeChannel(entry.localId);
  }

  // ===== open =====

  private async handleOpen(ws: WebSocket, message: Envelope): Promise<void> {
    const seq = typeof message.seq === 'number' ? message.seq : 0;
    const data = (message.data ?? {}) as { kind?: unknown; node?: ApiNode; cols?: unknown; rows?: unknown };
    if (data.kind !== 'pty' && data.kind !== 'sftp') {
      this.sendError(ws, 0, seq, `open: kind 必须是 "pty" 或 "sftp"，收到 ${String(data.kind)}`);
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

    const chan = ++this.nextChan;
    // 一次 open 只报一个错。握手失败会同时从两条路冒出来（连接的 ended 回调、
    // 以及 handshake() 的 rejection 走进 catch），不设闸前端就会为同一次失败弹两条错误。
    // settled 同时也是分界线：置位之后 ended 才算「通道级断开」，按 chan 上报。
    let settled = false;
    const opened = deferred<string | undefined>();

    const callbacks: ChannelCallbacks = {
      data: (payload, end) => this.sendData(ws, chan, payload, end),
      control: (envelope) => this.sendControl(ws, envelope.type, { chan, ...(envelope.data as object | undefined) }),
      error: (message) => this.sendError(ws, chan, 0, message),
      ready: (info) => opened.resolve(info),
      failed: (message) => opened.reject(new Error(message)),
    };

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
      this.connections.add(conn);
      const connection = conn;

      const prepared = (async () => {
        await withTimeout(connection.handshake(), HANDSHAKE_TIMEOUT_MS, 'SSH 握手超时');
        let entry: ChannelEntry;
        if (kind === 'pty') {
          const pty = new PTYHandler(connection, clampCols(data.cols), clampRows(data.rows), callbacks);
          const localId = connection.openPTY(pty);
          entry = { chan, kind, conn: connection, localId, pty, chain: Promise.resolve() };
        } else {
          const sftp = new SFTPHandler(connection, callbacks);
          const localId = connection.openSFTP(sftp);
          entry = { chan, kind, conn: connection, localId, sftp, chain: Promise.resolve() };
        }
        this.channels.set(chan, entry);
        return opened.promise;
      })();

      const home = await Promise.race([prepared, this.shutdown]);
      // 通道已就绪：往后再断开就是通道自己的事，不该再回填 open 的 seq。
      settled = true;
      if (this.closed) return;
      if (kind === 'pty') {
        this.sendControl(ws, 'open', {
          kind: 'pty',
          chan,
          chunk_size: PTYHandler.IN_FRAME,
          window: PTYHandler.WINDOW,
        }, seq);
      } else {
        this.sendControl(ws, 'open', {
          kind: 'sftp',
          chan,
          ...(home ? { home } : {}),
          window: SFTPHandler.WINDOW,
        }, seq);
      }
    } catch (error) {
      this.channels.delete(chan);
      if (conn) {
        this.connections.delete(conn);
        try { conn.close(); } catch { /* 已关闭 */ }
      }
      if (settled) return; // ended 回调已经把这次失败说清楚了
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

  private sendData(ws: WebSocket, chan: number, payload: Uint8Array, end?: boolean): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encodeFrame(chan, payload, end ?? false));
    } catch { /* 连接已断 */ }
  }
}
