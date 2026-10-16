// `cloudflare:sockets` 的替身。
//
// 真实模块只在 workerd 里存在，Node 里连 import 都解析不了，所以用 vitest 的 alias
// 换成本文件。工程里唯一 import 它的模块是 dial.ts —— 所有出网行为都收在那里，
// 于是这里只要提供「可注入的 connect」就够了。
//
// 用法：
//   setConnect((address) => fakeSocket());          // 注入一个必然连上的 socket
//   setConnect((address) => fakeSocket({ fail: true }));  // 注入一个连不上的 socket

export interface RecordedConnect {
  hostname: string;
  port: number;
  options: unknown;
}

export const connectCalls: RecordedConnect[] = [];

type ConnectImpl = (address: { hostname: string; port: number }, options?: unknown) => Socket;

let impl: ConnectImpl = () => {
  throw new Error('单测未注入 cloudflare:sockets 的 connect 实现');
};

export function connect(address: { hostname: string; port: number }, options?: unknown): Socket {
  connectCalls.push({ hostname: address.hostname, port: address.port, options });
  return impl(address, options);
}

export function setConnect(next: ConnectImpl): void {
  impl = next;
}

export function resetConnect(): void {
  connectCalls.length = 0;
  impl = () => {
    throw new Error('单测未注入 cloudflare:sockets 的 connect 实现');
  };
}

export interface FakeSocketOptions {
  /** true 时 opened 会以这个错误拒绝。 */
  fail?: unknown;
  /** 永不 settle，用来验证超时路径。 */
  hang?: boolean;
  /** close() 同步抛错，用来验证失败回收时的兜底 catch。 */
  closeThrows?: boolean;
}

/** fakeSocket 造一个形状够用的 Socket：只有 opened 与 close 会被 dial.ts 碰到。 */
export function fakeSocket(options: FakeSocketOptions = {}): Socket {
  const opened = options.hang
    ? new Promise<never>(() => undefined)
    : options.fail !== undefined
      ? Promise.reject(options.fail)
      : Promise.resolve();
  // 失败路径上没人 await 这个 rejection 的话会被当成未处理拒绝，这里先挂个空 catch。
  opened.catch(() => undefined);
  return {
    opened,
    closed: Promise.resolve(),
    close: options.closeThrows
      ? () => { throw new Error('socket 已经不可关闭'); }
      : async () => undefined,
    startTls: () => { throw new Error('unused'); },
    readable: new ReadableStream(),
    writable: new WritableStream(),
  } as unknown as Socket;
}
