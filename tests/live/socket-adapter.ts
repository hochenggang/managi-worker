// 把 Node 的 net.Socket 适配成 cloudflare:sockets 的 Socket 形状。
//
// 只给「真实服务器互通测试」用（tests/live/）。SSHConnection 一共只碰 socket 的三个东西：
// `.readable.getReader()`、`.writable.getWriter()`、`.close()`，所以这层很薄。
import type { Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';

export function adaptSocket(socket: Socket): Socket_shaped {
  return {
    readable: Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
    opened: Promise.resolve(),
    closed: new Promise<void>((resolve) => socket.once('close', () => resolve())),
    close: async () => {
      socket.destroy();
    },
    startTls: () => {
      throw new Error('互通测试不使用 startTls');
    },
  };
}

/** 结构上只需要这几个字段，不引 cloudflare:sockets 的类型。 */
export interface Socket_shaped {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<void>;
  close(): Promise<void>;
  startTls(): unknown;
}
