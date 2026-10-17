// 终端会话保活：WS 断开不等于 shell 断开。
//
// 以前的做法是「WS 一断把所有 SSH 连接全收掉」。真实网络里最贵的一次断线不是远端挂了，
// 而是浏览器标签被切后台、笔记本合盖、地铁里换个基站——那一刻用户正在跑的东西全没了。
// Go 版一直靠 sessionManager + scrollback 顶着这个场景，Worker 版现在补齐：
//
//   WS 断开 → detach（输出继续进 scrollback）
//   60s 内用同一 session_id 重连 → attach → 先回放 scrollback，再接实时输出
//   超时 → 关连接、从表里摘除
//
// 能保住的边界要说清楚：Durable Object 被回收（休眠、换机）时内存里的会话同样消失。
// 前端拿到的 open 响应会带 reattached，据此决定「接着用」还是「另起一个」。

import type { SSHConnection } from './session';
import { RingBuffer } from './ring';

/** 一路通道的出口：由 DO 提供，绑定了当前的 ws 与通道号。 */
export interface TerminalSink {
  /** 本通道在**当前连接**上的通道号：重连后是新号，session 不保留它。 */
  readonly chan: number;
  data(payload: Uint8Array, end?: boolean): void;
  control(envelope: { type: string; data?: unknown }): void;
  error(message: string): void;
}

/** 回放分片大小：与 PTY 输出帧同量级，前端按到达顺序 append 即可。 */
const REPLAY_FRAME = 32 * 1024;

export class TerminalSession {
  /** scrollback 上限。 */
  static readonly HISTORY_BYTES = 256 * 1024;
  /** WS 断开后保留多久：短到不会长期占着连接额度，长到能盖住一次页面重连。 */
  static readonly IDLE_TTL_MS = 60_000;

  private readonly history = new RingBuffer(TerminalSession.HISTORY_BYTES);
  private sink: TerminalSink | null = null;
  /** 闸门：响应写出之前不转发实时输出，否则前端会先收到一堆还不认识 chan 的字节。 */
  private held = true;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  private disposed = false;
  /** SSH 层的本地通道号：resize / close 要用。 */
  localId = 0;

  constructor(
    /** 会话身份（前端给的 session_id；缺省时用节点键）。 */
    readonly id: string,
    /** 节点身份（host:port:username）：复用会话前必须核对，否则能把别人机器上的 shell 接过来。 */
    readonly key: string,
    private readonly conn: SSHConnection,
    private readonly onGone: (session: TerminalSession) => void,
  ) {}

  get connection(): SSHConnection {
    return this.conn;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** push 是 SSH 输出的唯一入口：先落 scrollback，再（未挂起时）转给浏览器。 */
  push(payload: Uint8Array, end = false): void {
    if (this.disposed) return;
    if (end) this.ended = true;
    else if (payload.length > 0) this.history.append(payload);
    if (!this.held) this.sink?.data(payload, end);
    // 通道结束 = 这个 shell 没了：会话没有继续保留的意义。
    if (end) this.dispose('通道已结束');
  }

  /** notify 服务端主动推的控制帧（目前是 ack）。 */
  notify(envelope: { type: string; data?: unknown }): void {
    if (!this.held) this.sink?.control(envelope);
  }

  /** fail 通道级错误。 */
  fail(message: string): void {
    if (!this.held) this.sink?.error(message);
  }

  /** attach 挂上一个新通道并进入挂起状态（响应写出后必须紧跟 release）。 */
  attach(sink: TerminalSink): void {
    this.clearIdle();
    this.sink = sink;
    this.held = true;
  }

  /**
   * release 解除挂起：先回放 scrollback，再放实时输出进来。
   *
   * 必须在 open 响应写完之后**同步**调用。DO 单线程且这里没有 await，
   * 所以回放与之后的实时帧之间不会插进别的字节——Go 版靠写锁达成的同一件事。
   */
  release(): void {
    const sink = this.sink;
    if (!sink) return;
    const snapshot = this.history.snapshot();
    for (let pos = 0; pos < snapshot.length; pos += REPLAY_FRAME) {
      sink.data(snapshot.subarray(pos, pos + REPLAY_FRAME));
    }
    this.held = false;
  }

  /** detach 摘掉通道：输出只进 scrollback，并开始空闲计时。 */
  detach(): void {
    if (!this.sink) return;
    this.sink = null;
    this.held = true;
    if (this.ended || this.disposed) return;
    this.idleTimer = setTimeout(() => this.dispose('空闲超时'), TerminalSession.IDLE_TTL_MS);
  }

  /** dispose 关掉 SSH 连接并把自己摘除（幂等）。 */
  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sink = null;
    this.clearIdle();
    try { this.conn.close(); } catch { /* 已关闭 */ }
    this.onGone(this);
    void reason;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** nodeKeyOf 节点身份：复用会话与连接池都按它核对（大小写不敏感的主机名）。 */
export function nodeKeyOf(node: { host: string; port: number; username: string }): string {
  return `${node.host.trim().toLowerCase()}:${node.port}:${node.username}`;
}
