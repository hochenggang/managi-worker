// 只补 workerd 有、Node 里没有（或形态不同）的全局。
// 每个桩都写到「刚好够被测代码跑通」，不模拟协议细节 —— 细节由各用例自己驱动。

import { beforeEach } from 'vitest';
import { resetConnect } from './stubs/sockets';

/** 最小 WebSocket：记录发出去的东西，并让测试能模拟对端断开。 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** 只取文本帧，按到达顺序解析成对象 —— 控制面断言基本都用它。 */
  envelopes(): Array<Record<string, unknown>> {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as Record<string, unknown>);
  }

  /** 只取二进制帧。 */
  binaries(): Uint8Array[] {
    return this.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
  }
}

class FakeWebSocketPair {
  readonly 0: FakeWebSocket;
  readonly 1: FakeWebSocket;

  constructor() {
    this[0] = new FakeWebSocket();
    this[1] = new FakeWebSocket();
  }
}

const globals = globalThis as Record<string, unknown>;

globals.WebSocketPair ??= FakeWebSocketPair;

// Node 22 自带 WebSocket，但 DO 读的是 WebSocket.OPEN 这个静态常量。
// 自带实现里有，缺失时才补，避免覆盖掉运行时的真实行为。
const webSocketGlobal = globals.WebSocket as { OPEN?: number } | undefined;
if (webSocketGlobal && webSocketGlobal.OPEN === undefined) {
  Object.defineProperty(webSocketGlobal, 'OPEN', { value: 1, configurable: true });
}

beforeEach(() => {
  // sockets 桩是模块级状态，用例之间必须清干净，否则「上个用例注入的 connect」会漏过来。
  resetConnect();
});

export { FakeWebSocket, FakeWebSocketPair };
