import { describe, expect, it, vi } from 'vitest';
import { OutboundQueue, type OutboundHandlers } from '../src/outbound';
import type { ChannelDataChunk } from '../src/ssh/channel';

/** 模拟一条远端窗口只有 window 字节的通道：每次最多给 window 字节。 */
class FakeWindow {
  private left: number;
  readonly sent: Uint8Array[] = [];

  constructor(private readonly window: number) {
    this.left = window;
  }

  /** 补窗口（相当于收到 WINDOW_ADJUST）。 */
  adjust(bytes: number): void {
    this.left += bytes;
  }

  take(source: Uint8Array, offset: number): ChannelDataChunk | null {
    const available = source.length - offset;
    if (available <= 0) return { source, sourceOffset: offset, bytesConsumed: 0, payloadLength: 0 };
    if (this.left <= 0) return null;
    const bytes = Math.min(this.window, this.left, available);
    this.left -= bytes;
    return { source, sourceOffset: offset, bytesConsumed: bytes, payloadLength: 4 + bytes };
  }

  async send(chunk: ChannelDataChunk): Promise<void> {
    this.sent.push(chunk.source.slice(chunk.sourceOffset, chunk.sourceOffset + chunk.bytesConsumed));
  }
}

function makeQueue(options: {
  window?: number;
  failOn?: number;
  closed?: () => boolean;
} = {}) {
  const channel = new FakeWindow(options.window ?? 1024);
  const failures: Error[] = [];
  const chunks: number[] = [];
  let sends = 0;
  const handlers: OutboundHandlers<Uint8Array> = {
    takeChunk: (item, offset) => channel.take(item, offset),
    send: async (chunk) => {
      sends += 1;
      if (options.failOn !== undefined && sends >= options.failOn) throw new Error('写不进去');
      await channel.send(chunk);
    },
    lengthOf: (item) => item.length,
    isClosed: () => options.closed?.() ?? false,
    onFailure: (error) => failures.push(error),
    onChunk: (bytes) => chunks.push(bytes),
  };
  return { queue: new OutboundQueue(handlers), channel, failures, chunks };
}

describe('OutboundQueue', () => {
  it('按序把条目发完，每个条目发完才 resolve', async () => {
    const { queue, channel } = makeQueue();
    await Promise.all([queue.enqueue(new Uint8Array([1, 2, 3])), queue.enqueue(new Uint8Array([4, 5]))]);
    expect(channel.sent.map((chunk) => Array.from(chunk))).toEqual([[1, 2, 3], [4, 5]]);
    expect(queue.depth).toBe(0);
  });

  it('远端窗口用尽就停下，补窗口后从断点继续（不重发、不丢字节）', async () => {
    const { queue, channel, chunks } = makeQueue({ window: 2 });
    const done = queue.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
    // 窗口 2 字节：先发两片，然后停在原地等
    await Promise.resolve();
    await Promise.resolve();
    expect(chunks).toEqual([2]);
    channel.adjust(10);
    await queue.flush();
    await done;
    expect(channels(channel.sent)).toEqual([1, 2, 3, 4, 5]);
  });

  it('发送失败 → 清空队列、拒绝所有等待者、回调 onFailure', async () => {
    const { queue, failures } = makeQueue({ failOn: 1 });
    const first = queue.enqueue(new Uint8Array([1]));
    const second = queue.enqueue(new Uint8Array([2]));
    await expect(first).rejects.toThrow('写不进去');
    await expect(second).rejects.toThrow('写不进去');
    expect(failures).toHaveLength(1);
    expect(queue.depth).toBe(0);
  });

  it('clear 丢弃未发内容，并且不把等待者当作失败', async () => {
    const { queue } = makeQueue({ window: 0 });
    const pending = queue.enqueue(new Uint8Array([1, 2]));
    queue.clear();
    await expect(pending).resolves.toBeUndefined();
    expect(queue.depth).toBe(0);
  });

  it('已关闭时 enqueue 直接放行，不再往后堆', async () => {
    const { queue, channel } = makeQueue({ closed: () => true });
    await expect(queue.enqueue(new Uint8Array([1]))).resolves.toBeUndefined();
    expect(channel.sent).toHaveLength(0);
    expect(queue.depth).toBe(0);
  });

  it('重复 flush 不会把同一段发两遍', async () => {
    const { queue, channel } = makeQueue({ window: 1 });
    const done = queue.enqueue(new Uint8Array([1, 2]));
    await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
    channel.adjust(4);
    await queue.flush();
    await done;
    expect(channels(channel.sent)).toEqual([1, 2]);
  });
});

/** channels 把多段已发字节拍平，便于断言「最终发出去的内容」。 */
function channels(sent: Uint8Array[]): number[] {
  return sent.flatMap((chunk) => Array.from(chunk));
}
