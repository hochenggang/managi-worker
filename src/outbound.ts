// 往 SSH 通道写字节的串行队列。
//
// PTY 与 SFTP 之前各写了一套一模一样的「队列 + 头偏移 + flushing 闸 + 等窗口」，
// 连注释都差不多。修一处漏一处只是时间问题，所以收成这一个类。
//
// 它只管「按序把条目发完」，不关心条目是什么：终端是 Uint8Array，SFTP 是协议包。
// 远端窗口用尽时 takeChunk 返回 null，队列就地停下，等下一次 WINDOW_ADJUST 再 flush。

import type { ChannelDataChunk } from './ssh/channel';

export interface OutboundHandlers<T> {
  /** 取 item 从 offset 起可发的一段；null 表示远端窗口已满，等下一轮。 */
  takeChunk(item: T, offset: number): ChannelDataChunk | null;
  /** 一段发完后调用（PTY 用它推进前端输入窗口的 ack）。 */
  send(chunk: ChannelDataChunk): Promise<void>;
  /** 一个条目的总字节数，用来判断「这个条目发完了」。 */
  lengthOf(item: T): number;
  /** 队列是否已不可用（通道关掉 / 会话销毁）。 */
  isClosed(): boolean;
  /** 发送失败：队列已清空，调用方据此收尾。 */
  onFailure(error: Error): void;
  /** 每成功发完一段回调一次。 */
  onChunk?(bytes: number): void;
}

export class OutboundQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private offset = 0;
  private flushing = false;

  constructor(private readonly handlers: OutboundHandlers<T>) {}

  /** depth 当前排队条目数（测试与诊断用）。 */
  get depth(): number {
    return this.items.length;
  }

  /** enqueue 排入一个条目；返回的 Promise 在它整条发完后了结。 */
  enqueue(item: T): Promise<void> {
    if (this.handlers.isClosed()) return Promise.resolve();
    const done = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    this.items.push(item);
    void this.flush();
    return done;
  }

  /** flush 把能发的都发掉；并发调用无副作用（flushing 闸）。 */
  async flush(): Promise<void> {
    if (this.flushing || this.handlers.isClosed()) return;
    this.flushing = true;
    try {
      while (this.items.length > 0 && !this.handlers.isClosed()) {
        const head = this.items[0]!;
        const chunk = this.handlers.takeChunk(head, this.offset);
        if (!chunk) return; // 远端窗口用尽：等下一次 WINDOW_ADJUST
        await this.handlers.send(chunk);
        this.offset += chunk.bytesConsumed;
        this.handlers.onChunk?.(chunk.bytesConsumed);
        if (this.offset === this.handlers.lengthOf(head)) {
          this.items.shift();
          this.offset = 0;
          this.waiters.shift()?.resolve();
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.items.length = 0;
      this.offset = 0;
      for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
      this.handlers.onFailure(failure);
    } finally {
      this.flushing = false;
    }
  }

  /** clear 丢弃未发的内容（通道关闭时用）。等着的 Promise 直接放行，不当作失败。 */
  clear(): void {
    this.items.length = 0;
    this.offset = 0;
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }
}
