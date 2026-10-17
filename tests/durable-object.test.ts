import { beforeEach, describe, expect, it, vi } from 'vitest';

// DO 是本项目「浏览器 ↔ SSH」的拼接处：通道表、控制动词分发、数据帧投递、同通道串行化。
// 这里把 dial 与三个通道处理器整体换掉 —— 验收的是分发规则与生命周期收尾，
// SSH 协议栈本身由 src/ssh/ 负责（那部分要真实服务端才有意义）。
const mocks = vi.hoisted(() => ({ dialNode: vi.fn() }));

vi.mock('../src/dial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dial')>();
  return { ...actual, dialNode: (...args: unknown[]) => mocks.dialNode(...args) };
});

vi.mock('../src/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session')>();
  const { FakeConnection, FakeExecHandler, FakePTYHandler, FakeSFTPHandler } = await import('./fakes');
  return {
    ...actual,
    SSHConnection: FakeConnection,
    ExecHandler: FakeExecHandler,
    PTYHandler: FakePTYHandler,
    SFTPHandler: FakeSFTPHandler,
  };
});

import { ManagiSessionDO } from '../src/durable-object';
import { encodeFrame } from '../src/protocol';
import type { Env } from '../src/types';
import { FakeConnection, FakePTYHandler, FakeSFTPHandler, type FakeSFTPPlan } from './fakes';
import { FakeWebSocket } from './setup';

const NODE = { host: '1.2.3.4', port: 22, username: 'root', auth_type: 'password', auth_value: 'pw' };

// ===== 脚手架 =====

interface Harness {
  session: ManagiSessionDO;
  /** acceptWebSocket 收到的那些「服务端那半」。 */
  accepted: FakeWebSocket[];
  state: DurableObjectState;
}

function makeDO(stale: FakeWebSocket[] = []): Harness {
  const accepted: FakeWebSocket[] = [];
  const state = {
    getWebSockets: () => stale,
    acceptWebSocket: (ws: FakeWebSocket) => { accepted.push(ws); },
  } as unknown as DurableObjectState;
  return { session: new ManagiSessionDO(state, {} as Env), accepted, state };
}

/** flush 把挂起的微任务与任务链排空（链上的任务全部是 microtask 驱动）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const text = (value: unknown): string => JSON.stringify(value);

/**
 * 替身只实现被测代码真正用到的那几个成员，而 DO 的方法签名要的是完整 WebSocket。
 * 这里在测试侧对一次口径 —— 与其为了满足类型补 15 个用不上的成员，不如把口子开在明处。
 */
type TestSocket = FakeWebSocket & WebSocket;

const newSocket = (): TestSocket => new FakeWebSocket() as unknown as TestSocket;

let ws: TestSocket;
let connection: FakeConnection;

beforeEach(() => {
  FakePTYHandler.reset();
  FakeSFTPHandler.reset();
  ws = newSocket();
  connection = new FakeConnection();
  mocks.dialNode.mockReset();
  mocks.dialNode.mockResolvedValue(connection);
});

/** open 发一个 open 动词并等它落地（已就绪时 webSocketMessage 会在就绪后才返回）。 */
async function open(session: ManagiSessionDO, kind: 'pty' | 'sftp', seq = 1): Promise<void> {
  await session.webSocketMessage(ws, text({ type: 'open', data: { kind, node: NODE }, seq }));
}

const lastEnvelope = (): Record<string, unknown> => ws.envelopes().at(-1)!;

/**
 * Node 的 Response 构造器只接 200-599 的状态码（Fetch 规范），而 DO 的 fetch 必须回 101。
 * 用一个只放宽这一处的子类绕过去，其余行为原样继承。
 */
async function withUpgradeStatus<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.Response;
  class LenientResponse extends original {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      super(body, { ...init, status: init?.status === 101 ? 200 : init?.status });
      // super 只肯存 200-599，把它改写过的 101 还原回来，断言才看得见真实状态。
      Object.defineProperty(this, 'status', { value: init?.status ?? 200, configurable: true });
      if (init && 'webSocket' in init) {
        Object.defineProperty(this, 'webSocket', { value: init.webSocket, configurable: true });
      }
    }
  }
  (globalThis as Record<string, unknown>).Response = LenientResponse;
  try {
    return await run();
  } finally {
    (globalThis as Record<string, unknown>).Response = original;
  }
}

// ===== 构造 =====

describe('构造', () => {
  it('实例重启时把残留的 WebSocket 以 1012 关掉（内存里的 SSH 状态已经没了）', () => {
    const stale = new FakeWebSocket();
    makeDO([stale]);
    expect(stale.closes).toEqual([{ code: 1012, reason: 'Worker 会话已重启，请重新连接' }]);
    expect(stale.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('没有残留连接时不动任何东西', () => {
    expect(() => makeDO()).not.toThrow();
  });

  it('残留连接已经关掉时不会把构造打断', () => {
    const stale = new FakeWebSocket();
    stale.close = () => { throw new Error('already closed'); };
    expect(() => makeDO([stale])).not.toThrow();
  });
});

// ===== fetch =====

describe('fetch', () => {
  it('非 /connect → 404', async () => {
    const { session } = makeDO();
    const response = await session.fetch(new Request('https://session.internal/nope'));
    expect(response.status).toBe(404);
  });

  it('没有 Upgrade 头 → 426', async () => {
    const { session } = makeDO();
    const response = await session.fetch(new Request('https://session.internal/connect'));
    expect(response.status).toBe(426);
  });

  it('Upgrade 大小写不敏感', async () => {
    const { session, accepted } = makeDO();
    await withUpgradeStatus(async () => {
      const response = await session.fetch(new Request('https://session.internal/connect', {
        headers: { Upgrade: 'WebSocket' },
      }));
      expect(response.status).toBe(101);
      expect(accepted).toHaveLength(1);
    });
  });

  it('升级成功 → 101，服务端那半交给 acceptWebSocket、客户端那半回给调用方', async () => {
    const { session, accepted } = makeDO();
    await withUpgradeStatus(async () => {
      const response = await session.fetch(new Request('https://session.internal/connect', {
        headers: { Upgrade: 'websocket' },
      }));
      expect(response.status).toBe(101);
      expect(accepted).toHaveLength(1);
      expect((response as unknown as { webSocket?: unknown }).webSocket).toBeDefined();
    });
  });
});

// ===== 控制面：通用 =====

describe('webSocketMessage —— 短信封', () => {
  it('不是合法 JSON → error「控制帧不是合法 JSON」', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, '这不是 json');
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: '控制帧不是合法 JSON' } });
  });

  it('缺 type 字段也算非法（撑不起一次分发）', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ data: {} }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: '控制帧不是合法 JSON' } });
  });

  it('ping → pong，seq 原样带回', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'ping', seq: 7 }));
    expect(lastEnvelope()).toEqual({ type: 'pong', seq: 7 });
  });

  it('ping 不带 seq 时不回填 seq（0 表示不等回复）', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'ping' }));
    expect(lastEnvelope()).toEqual({ type: 'pong' });
  });

  it('未知动词 → error 里回显动词名', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'frobnicate', seq: 3 }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: '未知动词：frobnicate' }, seq: 3 });
  });

  it('会话已关闭后什么也不做（连错误都不回）', async () => {
    const { session } = makeDO();
    await session.webSocketClose();
    await session.webSocketMessage(ws, text({ type: 'ping', seq: 1 }));
    expect(ws.envelopes()).toEqual([]);
  });

  it('WS 不是 OPEN 时静默丢弃（对端已经走了）', async () => {
    const { session } = makeDO();
    ws.readyState = FakeWebSocket.CLOSED;
    await session.webSocketMessage(ws, text({ type: 'ping', seq: 1 }));
    expect(ws.sent).toEqual([]);
  });

  it('WS 已经不可写时，往里推数据不会撞出异常', async () => {
    const { session } = makeDO();
    FakeSFTPHandler.plan = { downloadMeta: { filename: 'a.bin', total: 2, chunks: [new Uint8Array(2)] } };
    await open(session, 'sftp');
    ws.readyState = FakeWebSocket.CLOSED;
    ws.sent.length = 0;
    await session.webSocketMessage(ws, text({ type: 'download', data: { chan: 1, path: '/a.bin' }, seq: 2 }));
    await flush();
    expect(ws.sent).toEqual([]);
  });

  it('send 本身抛错时也只是丢掉这一帧（比如对端刚好在这一瞬断开）', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    ws.send = () => { throw new Error('socket is not open'); };
    await expect(session.webSocketMessage(ws, text({ type: 'ping', seq: 2 }))).resolves.toBeUndefined();
  });
});

// ===== open =====

describe('open', () => {
  it('kind 只能是 pty / sftp', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'shell', node: NODE }, seq: 4 }));
    expect(lastEnvelope()).toEqual({
      type: 'error',
      data: { message: 'open: kind 必须是 "pty" 或 "sftp"，收到 shell' },
      seq: 4,
    });
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('open 连 data 都没带 → 按「kind 非法」拒绝，不是崩掉', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'open', seq: 4 }));
    expect(lastEnvelope()).toEqual({
      type: 'error',
      data: { message: 'open: kind 必须是 "pty" 或 "sftp"，收到 undefined' },
      seq: 4,
    });
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('节点描述不合法时前置拦下，不去建连', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: { ...NODE, host: '' } }, seq: 5 }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: 'open: 节点地址(host)为空' }, seq: 5 });
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('pty 就绪 → open 响应带 chan / chunk_size / window', async () => {
    const { session } = makeDO();
    await open(session, 'pty', 1);
    expect(ws.envelopes()).toEqual([{
      type: 'open',
      data: { kind: 'pty', chan: 1, chunk_size: FakePTYHandler.IN_FRAME, window: FakePTYHandler.WINDOW },
      seq: 1,
    }]);
    expect(FakePTYHandler.created).toHaveLength(1);
  });

  it('首连信任（TOFU）→ open 响应把主机指纹带回去（让它能被看见一次）', async () => {
    const { session } = makeDO();
    connection.hostKeyInfo = { fingerprint: 'SHA256:abc123', recorded: true };
    FakeSFTPHandler.plan = { readyInfo: '/home/tester' };
    await open(session, 'sftp', 3);
    expect(ws.envelopes()).toEqual([{
      type: 'open',
      data: {
        kind: 'sftp',
        chan: 1,
        home: '/home/tester',
        window: FakeSFTPHandler.WINDOW,
        host_key: { fingerprint: 'SHA256:abc123', recorded: true },
      },
      seq: 3,
    }]);
  });

  it('sftp 就绪 → open 响应带 chan / home / window', async () => {
    const { session } = makeDO();
    FakeSFTPHandler.plan = { readyInfo: '/home/tester' };
    await open(session, 'sftp', 2);
    expect(ws.envelopes()).toEqual([{
      type: 'open',
      data: { kind: 'sftp', chan: 1, home: '/home/tester', window: FakeSFTPHandler.WINDOW },
      seq: 2,
    }]);
  });

  it('SFTP 拿不到 home 时该字段不出现（前端按「没有」处理）', async () => {
    const { session } = makeDO();
    FakeSFTPHandler.plan = { readyInfo: '' };
    await open(session, 'sftp', 2);
    const envelope = lastEnvelope();
    expect(envelope.data).toEqual({ kind: 'sftp', chan: 1, window: FakeSFTPHandler.WINDOW });
  });

  it('pty 收到 cols/rows 才用，缺省由 clamp 兜底', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: NODE, cols: 132, rows: 43 }, seq: 1 }));
    expect(FakePTYHandler.created[0]!.cols).toBe(132);
    expect(FakePTYHandler.created[0]!.rows).toBe(43);
  });

  it('每次 open 拿一个新通道号（同一个浏览器连接上多开标签）', async () => {
    const { session } = makeDO();
    mocks.dialNode.mockImplementation(async () => new FakeConnection());
    await open(session, 'pty', 1);
    await open(session, 'sftp', 2);
    const chans = ws.envelopes().map((item) => (item.data as { chan: number }).chan);
    expect(chans).toEqual([1, 2]);
  });

  it('建连失败 → error 用「主机:端口 — 原因」，并把本次 open 的 seq 带上', async () => {
    const { session } = makeDO();
    mocks.dialNode.mockRejectedValue(new Error('TCP 连接超时'));
    await session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: NODE }, seq: 9 }));
    expect(lastEnvelope()).toEqual({
      type: 'error',
      data: { message: '1.2.3.4:22 — TCP 连接超时' },
      seq: 9,
    });
  });

  it('握手失败 → 同一条错误文案，并且连接被收掉（不留挂着的 socket）', async () => {
    const { session } = makeDO();
    const dead = new FakeConnection({ handshakeError: new Error('密钥协商失败') });
    mocks.dialNode.mockResolvedValue(dead);
    await session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: NODE }, seq: 11 }));
    expect(lastEnvelope()).toEqual({
      type: 'error',
      data: { message: '1.2.3.4:22 — 密钥协商失败' },
      seq: 11,
    });
    expect(dead.closeCount).toBe(1);
  });

  it('凭据被拒时不硬套 主机:端口 前缀（原因本身已经说清楚了）', async () => {
    const { session } = makeDO();
    mocks.dialNode.mockRejectedValue(new Error('凭据错误'));
    const { SSHAuthDefectError } = await import('../src/session');
    mocks.dialNode.mockRejectedValue(new SSHAuthDefectError('SSH 认证失败：用户名、密码或私钥不正确'));
    await session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: NODE }, seq: 12 }));
    expect(lastEnvelope()).toEqual({
      type: 'error',
      data: { message: 'SSH 认证失败：用户名、密码或私钥不正确' },
      seq: 12,
    });
  });

  it('通道就绪前连接就断了 → 只报一次，且用 open 的 seq', async () => {
    const { session } = makeDO();
    const half = new FakeConnection({ autoReady: false });
    let ended: ((error: Error) => void) | null = null;
    mocks.dialNode.mockImplementation(async (_env: unknown, _node: unknown, options: { onEnded: (e: Error) => void }) => {
      ended = options.onEnded;
      return half;
    });

    const pending = session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: NODE }, seq: 13 }));
    await vi.waitFor(() => expect(ended).not.toBeNull());
    ended!(new Error('远端断开'));

    expect(ws.envelopes()).toEqual([{
      type: 'error',
      data: { message: '1.2.3.4:22 — 远端断开' },
      seq: 13,
    }]);

    // 关掉会话，把还挂在 opened 上的那次 open 放走。
    await session.webSocketClose();
    await pending;
    expect(ws.envelopes()).toHaveLength(1);
  });

  it('通道就绪之后再断 → 按 chan 上报（已经是通道自己的事，不该回填 open 的 seq）', async () => {
    const { session } = makeDO();
    let ended: ((error: Error) => void) | null = null;
    mocks.dialNode.mockImplementation(async (_env: unknown, _node: unknown, options: { onEnded: (e: Error) => void }) => {
      ended = options.onEnded;
      return connection;
    });
    await open(session, 'pty', 1);
    ended!(new Error('远端断开'));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: '远端断开' } });
  });
});

// ===== 数据面 =====

describe('webSocketMessage —— 二进制帧', () => {
  const frameOf = (chan: number, payload: Uint8Array, end = false): ArrayBuffer =>
    encodeFrame(chan, payload, end).buffer as ArrayBuffer;

  it('帧头不足 → 报错并关闭连接（留在错位上只会产出坏文件）', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: '数据帧帧头不完整' } });
    expect(ws.closes).toEqual([{ code: 1003, reason: 'Malformed data frame' }]);
  });

  it('未知通道 → 静默丢弃（通道可能刚被关掉，报错只会刷屏）', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, frameOf(99, new Uint8Array([1])));
    await flush();
    expect(ws.sent).toEqual([]);
  });

  it('pty 通道上的字节交给 queueInput', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    await session.webSocketMessage(ws, frameOf(1, new Uint8Array([1, 2, 3])));
    const handler = connection.handlerOf('pty') as FakePTYHandler;
    expect(handler.inputs).toHaveLength(1);
    expect([...handler.inputs[0]!]).toEqual([1, 2, 3]);
  });

  it('sftp 通道上的字节写进上传文件', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, frameOf(1, new Uint8Array([9, 9])));
    await flush();
    const handler = FakeSFTPHandler.created[0]!;
    expect(handler.written).toHaveLength(1);
    expect([...handler.written[0]!]).toEqual([9, 9]);
  });

  it('空帧不产生一次写（前端分片会有零长度的心跳片）', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, frameOf(1, new Uint8Array(0)));
    await flush();
    expect(FakeSFTPHandler.created[0]!.written).toEqual([]);
    expect(ws.envelopes().filter((item) => item.type === 'upload_end')).toEqual([]);
  });

  it('带 END 标志 → 收尾上传并回 upload_end', async () => {
    const { session } = makeDO();
    FakeSFTPHandler.plan = { finishUploadSize: 42 };
    await open(session, 'sftp');
    await session.webSocketMessage(ws, frameOf(1, new Uint8Array([9]), true));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'upload_end', data: { chan: 1, size: 42 } });
  });

  it('收尾失败 → 以通道级 error 报出，不影响别的通道', async () => {
    const { session } = makeDO();
    FakeSFTPHandler.plan = { finishUploadError: new Error('磁盘写满') };
    await open(session, 'sftp');
    await session.webSocketMessage(ws, frameOf(1, new Uint8Array(0), true));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: '磁盘写满' } });
  });
});

// ===== close / resize =====

describe('close', () => {
  it('正常关闭：SSH 侧通道被关，通道表里也查不到了', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    const localId = connection.handlers[0]!.localId;
    await session.webSocketMessage(ws, text({ type: 'close', data: { chan: 1 }, seq: 2 }));
    expect(connection.closedChannels).toEqual([localId]);

    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/' }, seq: 3 }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: '未知通道 1' }, seq: 3 });
  });

  it('chan 非法 → 静默（不是能自愈的事，但也不值得打断对端）', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'close', data: {} }));
    await session.webSocketMessage(ws, text({ type: 'close', data: { chan: 0 } }));
    expect(ws.sent).toEqual([]);
  });

  it('未知 chan → 静默', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'close', data: { chan: 8 } }));
    expect(ws.sent).toEqual([]);
  });
});

describe('resize', () => {
  it('pty 通道上把尺寸透给 SSH 层', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    await session.webSocketMessage(ws, text({ type: 'resize', data: { chan: 1, cols: 100, rows: 30 } }));
    expect(connection.resizes).toEqual([{ localId: connection.handlers[0]!.localId, cols: 100, rows: 30 }]);
  });

  it('非 pty 通道 → 静默（resize 是 seq=0 的自愈提示）', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    ws.sent.length = 0; // 先清掉 open 那条
    await session.webSocketMessage(ws, text({ type: 'resize', data: { chan: 1, cols: 100, rows: 30 } }));
    expect(connection.resizes).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it('尺寸不是数字 → 静默', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    await session.webSocketMessage(ws, text({ type: 'resize', data: { chan: 1, cols: '100', rows: 30 } }));
    expect(connection.resizes).toEqual([]);
  });

  it('chan 非法 → 静默', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'resize', data: { cols: 1, rows: 1 } }));
    expect(ws.sent).toEqual([]);
  });

  it('连 data 都没带 → 静默', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'resize' }));
    expect(ws.sent).toEqual([]);
  });
});

// ===== SFTP 动词 =====

describe('SFTP 动词', () => {
  const sftpPlan = (plan: FakeSFTPPlan): void => { FakeSFTPHandler.plan = plan; };

  it('ls 非空目录 → 回 path 与 files', async () => {
    const { session } = makeDO();
    const files = [{ filename: 'a.txt', size: 1, mode: '-rw-r--r--', is_dir: false, mtime: 0 }];
    sftpPlan({ listResult: { path: '/tmp', files } });
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/tmp' }, seq: 10 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'ls', data: { chan: 1, path: '/tmp', files }, seq: 10 });
  });

  it('ls 被上限截断 → 带 truncated 标记', async () => {
    const { session } = makeDO();
    const files = [{ filename: 'a.txt', size: 1, mode: '-rw-r--r--', is_dir: false, mtime: 0 }];
    sftpPlan({ listResult: { path: '/huge', files, truncated: true } });
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/huge' }, seq: 10 }));
    await flush();
    expect(lastEnvelope()).toEqual({
      type: 'ls', data: { chan: 1, path: '/huge', files, truncated: true }, seq: 10,
    });
  });

  it('ls 空目录 → 省略 files 字段（与后端契约一致）', async () => {
    const { session } = makeDO();
    sftpPlan({ listResult: { path: '/empty', files: [] } });
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/empty' }, seq: 10 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'ls', data: { chan: 1, path: '/empty' }, seq: 10 });
  });

  // 注意：任务链上的失败一律以 chan 定位，不回填 seq（enqueue 的 catch 用 seq=0）。
  // 前端只把 error 当提示文案用，不对它做请求配对 —— 这里把既有行为钉住，
  // 顺带记下它与「入参校验失败」那条路（走 sendError(ws, 0, seq, ...)）并不一致。

  it('ls 缺 path → 通道级 error', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1 }, seq: 10 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: 'ls: path 必填' } });
  });

  it('ls 打在不存在的通道上 → 未知通道', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 5, path: '/' }, seq: 10 }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 5, message: '未知通道 5' }, seq: 10 });
  });

  it('ls 打在 pty 通道上 → 说清楚这不是 SFTP 通道', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/' }, seq: 10 }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: 'ls: 这不是 SFTP 通道' }, seq: 10 });
  });

  it('ls 不带 chan → chan 缺失或非法', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'ls', data: { path: '/' }, seq: 10 }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: 'chan 缺失或非法' }, seq: 10 });
  });

  it('mkdir 成功 → 回 path', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'mkdir', data: { chan: 1, path: '/new' }, seq: 11 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'mkdir', data: { chan: 1, path: '/new' }, seq: 11 });
    expect(FakeSFTPHandler.created[0]!.mkdirCalls).toEqual(['/new']);
  });

  it('rm 成功 → 回 path', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'rm', data: { chan: 1, path: '/gone' }, seq: 12 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'rm', data: { chan: 1, path: '/gone' }, seq: 12 });
    expect(FakeSFTPHandler.created[0]!.removeCalls).toEqual(['/gone']);
  });

  it('mkdir 失败 → 通道级 error', async () => {
    const { session } = makeDO();
    sftpPlan({ mkdirError: new Error('权限不足') });
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'mkdir', data: { chan: 1, path: '/new' }, seq: 11 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: '权限不足' } });
  });

  it('upload 成功 → 回 offset 与 chunk_size', async () => {
    const { session } = makeDO();
    sftpPlan({ beginUploadResult: { offset: 100, chunk_size: 65536 } });
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({
      type: 'upload',
      data: { chan: 1, path: '/tmp', filename: 'a.bin', size: 900, mtime: 1700000000 },
      seq: 13,
    }));
    await flush();
    expect(lastEnvelope()).toEqual({
      type: 'upload',
      data: { chan: 1, offset: 100, chunk_size: 65536 },
      seq: 13,
    });
    expect(FakeSFTPHandler.created[0]!.uploadCalls).toEqual([
      { dir: '/tmp', filename: 'a.bin', size: 900, mtime: 1700000000 },
    ]);
  });

  it('upload 缺 filename → 明确拒绝', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'upload', data: { chan: 1, path: '/tmp' }, seq: 13 }));
    await flush();
    expect(lastEnvelope()).toEqual({ type: 'error', data: { chan: 1, message: 'upload: filename 必填' } });
  });

  it('upload 的 size / mtime 非数字时按 0 处理（新文件不带续传身份）', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({
      type: 'upload',
      data: { chan: 1, path: '/tmp', filename: 'a.bin', size: 'big', mtime: Number.NaN },
      seq: 13,
    }));
    await flush();
    expect(FakeSFTPHandler.created[0]!.uploadCalls[0]).toMatchObject({ size: 0, mtime: 0 });
  });

  it('upload 不带 data → chan 缺失或非法（不是崩掉）', async () => {
    const { session } = makeDO();
    await session.webSocketMessage(ws, text({ type: 'upload' }));
    expect(lastEnvelope()).toEqual({ type: 'error', data: { message: 'chan 缺失或非法' } });
  });

  it('upload 不带 path 时按根目录处理', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'upload', data: { chan: 1, filename: 'a.bin' }, seq: 13 }));
    await flush();
    expect(FakeSFTPHandler.created[0]!.uploadCalls[0]).toMatchObject({ dir: '', filename: 'a.bin' });
  });

  it('download → 先回控制帧，再推字节（顺序反了前端不知道这堆字节属于谁）', async () => {
    const { session } = makeDO();
    sftpPlan({ downloadMeta: { filename: 'a.bin', total: 3, chunks: [new Uint8Array([7, 7, 7])] } });
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'download', data: { chan: 1, path: '/a.bin' }, seq: 14 }));
    await flush();
    expect(ws.envelopes().at(-1)).toEqual({
      type: 'download',
      data: { chan: 1, filename: 'a.bin', total: 3 },
      seq: 14,
    });
    const binaries = ws.binaries();
    expect(binaries).toHaveLength(2); // 一片数据 + 一片 END
    expect([...binaries[0]!.subarray(6)]).toEqual([7, 7, 7]);
    expect(binaries[1]!.byteLength).toBe(6);
  });
});

// ===== 串行化 =====

describe('同通道任务链', () => {
  it('前一个动词没跑完，后一个不开始（顺序错了文件就写坏了）', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    const handler = FakeSFTPHandler.created[0]!;

    const steps: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    handler.list = async (path: string) => {
      steps.push(`ls:start:${path}`);
      await gate;
      steps.push(`ls:end:${path}`);
      return { path, files: [] };
    };
    handler.mkdir = async (path: string) => { steps.push(`mkdir:${path}`); };

    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/a' }, seq: 1 }));
    await session.webSocketMessage(ws, text({ type: 'mkdir', data: { chan: 1, path: '/b' }, seq: 2 }));
    await flush();
    expect(steps).toEqual(['ls:start:/a']);

    release();
    await flush();
    expect(steps).toEqual(['ls:start:/a', 'ls:end:/a', 'mkdir:/b']);
  });

  it('一条任务出错不会卡死后续任务', async () => {
    const { session } = makeDO();
    FakeSFTPHandler.plan = { listError: new Error('读不了') };
    await open(session, 'sftp');
    await session.webSocketMessage(ws, text({ type: 'ls', data: { chan: 1, path: '/a' }, seq: 1 }));
    await flush();
    await session.webSocketMessage(ws, text({ type: 'mkdir', data: { chan: 1, path: '/b' }, seq: 2 }));
    await flush();
    expect(ws.envelopes().at(-1)).toEqual({ type: 'mkdir', data: { chan: 1, path: '/b' }, seq: 2 });
  });
});

// ===== 会话收尾 =====

describe('会话收尾', () => {
  it('WS 关闭 → 所有 SSH 连接被收掉', async () => {
    const { session } = makeDO();
    const first = new FakeConnection();
    const second = new FakeConnection();
    mocks.dialNode.mockImplementation(async () => first);
    await open(session, 'pty', 1);
    mocks.dialNode.mockImplementation(async () => second);
    await open(session, 'sftp', 2);

    await session.webSocketClose();
    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
  });

  it('WS 报错 → 与正常关闭同样收尾', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    await session.webSocketError();
    expect(connection.closeCount).toBe(1);
  });

  it('重复收尾只做一次（close 与 error 可能接连到来）', async () => {
    const { session } = makeDO();
    await open(session, 'pty');
    await session.webSocketClose();
    await session.webSocketError();
    expect(connection.closeCount).toBe(1);
  });

  it('收尾之后浏览器再发控制帧与数据帧都无响应', async () => {
    const { session } = makeDO();
    await open(session, 'sftp');
    await session.webSocketClose();
    await session.webSocketMessage(ws, text({ type: 'ping', seq: 1 }));
    await session.webSocketMessage(ws, encodeFrame(1, new Uint8Array([1])).buffer as ArrayBuffer);
    await flush();
    expect(ws.envelopes()).toHaveLength(1); // 只有最初那条 open
  });

  it('握手中途 WS 断开 → open 不会把错误再报一遍', async () => {
    const { session } = makeDO();
    const half = new FakeConnection({ autoReady: false });
    mocks.dialNode.mockResolvedValue(half);
    const pending = session.webSocketMessage(ws, text({ type: 'open', data: { kind: 'pty', node: NODE }, seq: 1 }));
    await flush();
    await session.webSocketClose();
    await pending;
    expect(ws.envelopes()).toEqual([]);
  });

  it('对端已经走了之后，迟到的结束回调不再往浏览器写', async () => {
    const { session } = makeDO();
    let ended: ((error: Error) => void) | null = null;
    mocks.dialNode.mockImplementation(async (_env: unknown, _node: unknown, options: { onEnded: (e: Error) => void }) => {
      ended = options.onEnded;
      return connection;
    });
    await open(session, 'pty', 1);
    await session.webSocketClose();
    // workerd 触发 close 回调时这条 socket 已经写不了了 —— 替身要跟着变成 CLOSED，
    // 否则测的是替身的宽容度，而不是 DO 自己的 readyState 闸。
    ws.readyState = FakeWebSocket.CLOSED;
    ws.sent.length = 0;
    ended!(new Error('远端断开'));
    expect(ws.sent).toEqual([]);
  });
});
