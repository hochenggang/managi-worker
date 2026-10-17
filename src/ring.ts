// 终端 scrollback：只保留最近若干字节的有界缓冲。
//
// 为什么需要它：Worker 版以前「WS 一断就全收掉」，网络抖一下用户就丢了正在跑的
// 命令与全部输出。把输出留在环里，重连回放即可继续看——这是与 Go 版对齐的能力。
//
// 超限时从头部丢字节，但不能丢在半个 UTF-8 字符中间：截断点若落在续字节上，
// 回放的第一屏会是一个 U+FFFD。safeCut 负责把截断点推到下一个字符起始处。

/** 默认容量 256KB：够回看几百行终端输出，又不至于把 DO 内存撑起来。 */
export const DEFAULT_MAX_BYTES = 256 * 1024;

export class RingBuffer {
  private data = new Uint8Array(0);

  constructor(private readonly max: number = DEFAULT_MAX_BYTES) {}

  /** append 追加字节，超限丢头部。 */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.data.length + chunk.length);
    merged.set(this.data);
    merged.set(chunk, this.data.length);
    this.data = merged.length > this.max
      ? merged.subarray(safeCut(merged, merged.length - this.max))
      : merged;
  }

  /** snapshot 返回当前内容的副本：内部切片不外泄（否则调用方一改就毁了缓冲）。 */
  snapshot(): Uint8Array {
    return new Uint8Array(this.data);
  }

  get length(): number {
    return this.data.length;
  }

  clear(): void {
    this.data = new Uint8Array(0);
  }
}

/**
 * safeCut 从 from 起找到第一个字符起始位置。
 * UTF-8 的续字节是 10xxxxxx；截在它前面就等于把那个字符劈开。
 */
export function safeCut(data: Uint8Array, from: number): number {
  if (from <= 0) return 0;
  let cursor = Math.min(from, data.length);
  while (cursor < data.length && (data[cursor] & 0xc0) === 0x80) cursor += 1;
  return cursor;
}
