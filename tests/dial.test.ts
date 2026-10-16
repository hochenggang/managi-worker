import { describe, expect, it, vi } from 'vitest';
import { connectTimeoutMs, dialNode, openVerifiedSocket } from '../src/dial';
import { SSHConnection } from '../src/session';
import type { ApiNode } from '../src/protocol';
import type { Env } from '../src/types';
import { connectCalls, fakeSocket, setConnect } from './stubs/sockets';

// 用一层薄包装观察「尺寸参数有没有被传下去」——这是 dial → node 之间唯一的契约。
const spy = vi.hoisted(() => ({ buildNodeConfig: vi.fn() }));
vi.mock('../src/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/node')>();
  spy.buildNodeConfig.mockImplementation(actual.buildNodeConfig);
  return { ...actual, buildNodeConfig: spy.buildNodeConfig };
});

const env = (patch: Partial<Env> = {}): Env => ({ HOST_KEY_MODE: 'off', ...patch } as unknown as Env);
const node = (patch: Partial<ApiNode> = {}): ApiNode =>
  ({ host: '1.2.3.4', port: 2222, username: 'root', auth_value: 'pw', ...patch });

describe('connectTimeoutMs', () => {
  it('未配置时用 10 秒', () => {
    expect(connectTimeoutMs(undefined)).toBe(10_000);
  });

  it('合法值原样使用', () => {
    expect(connectTimeoutMs('3000')).toBe(3000);
    expect(connectTimeoutMs('2000')).toBe(2000);
    expect(connectTimeoutMs('30000')).toBe(30_000);
  });

  it('低于 2 秒抬到 2 秒（太短会把慢网络误判成故障）', () => {
    expect(connectTimeoutMs('1')).toBe(2000);
    expect(connectTimeoutMs('500')).toBe(2000);
    expect(connectTimeoutMs('-100')).toBe(2000);
  });

  it('高于 30 秒压到 30 秒（不能让一次请求挂到超时上限）', () => {
    expect(connectTimeoutMs('60000')).toBe(30_000);
    expect(connectTimeoutMs('999999999')).toBe(30_000);
  });

  it('坏值回退默认（空串要当「没配」而不是 Number("")=0）', () => {
    expect(connectTimeoutMs('abc')).toBe(10_000);
    expect(connectTimeoutMs('')).toBe(10_000);
    expect(connectTimeoutMs('   ')).toBe(10_000);
    expect(connectTimeoutMs('NaN')).toBe(10_000);
    expect(connectTimeoutMs('Infinity')).toBe(10_000);
  });

  it('首尾空格不影响解析（有人在 wrangler.toml 里手抄过值）', () => {
    expect(connectTimeoutMs(' 3000 ')).toBe(3000);
  });

  it('小数向下取整', () => {
    expect(connectTimeoutMs('3000.9')).toBe(3000);
  });

  it('科学计数法写的时间戳也认（不会被当成坏值）', () => {
    expect(connectTimeoutMs('1e4')).toBe(10_000);
  });
});

describe('openVerifiedSocket', () => {
  it('第一个地址就成功时只连一次', async () => {
    setConnect(() => fakeSocket());
    const socket = await openVerifiedSocket(['1.2.3.4'], 22, 1000);
    expect(socket).toBeDefined();
    expect(connectCalls).toEqual([
      { hostname: '1.2.3.4', port: 22, options: { secureTransport: 'off', allowHalfOpen: false } },
    ]);
  });

  it('前一个地址连不上就换下一个（多 A 记录时很有用）', async () => {
    let attempt = 0;
    setConnect(() => {
      attempt += 1;
      return attempt === 1 ? fakeSocket({ fail: new Error('连不上') }) : fakeSocket();
    });
    await expect(openVerifiedSocket(['1.1.1.1', '1.1.1.2'], 22, 1000)).resolves.toBeDefined();
    expect(connectCalls.map((call) => call.hostname)).toEqual(['1.1.1.1', '1.1.1.2']);
  });

  it('全部失败时抛出最后一个错误（不是第一个，最后一个最接近真相）', async () => {
    let attempt = 0;
    setConnect(() => {
      attempt += 1;
      return fakeSocket({ fail: new Error(`第 ${attempt} 个失败`) });
    });
    await expect(openVerifiedSocket(['1.1.1.1', '1.1.1.2'], 22, 1000)).rejects.toThrow('第 2 个失败');
  });

  it('地址列表为空时立刻报错，不去 connect', async () => {
    setConnect(() => fakeSocket());
    await expect(openVerifiedSocket([], 22, 1000)).rejects.toThrow('没有可用的目标地址');
    expect(connectCalls).toHaveLength(0);
  });

  it('IPv6 字面量带方括号交给 connect（不带的话出口解析不了）', async () => {
    setConnect(() => fakeSocket());
    await openVerifiedSocket(['2606:4700::1111'], 22, 1000);
    expect(connectCalls[0]!.hostname).toBe('[2606:4700::1111]');
  });

  it('迟迟连不上时按超时放弃', async () => {
    setConnect(() => fakeSocket({ hang: true }));
    await expect(openVerifiedSocket(['1.2.3.4'], 22, 20)).rejects.toThrow('TCP 连接超时');
  });

  it('超时之后还会换下一个地址试（不是直接放弃整批）', async () => {
    let attempt = 0;
    setConnect(() => {
      attempt += 1;
      return attempt === 1 ? fakeSocket({ hang: true }) : fakeSocket();
    });
    await expect(openVerifiedSocket(['1.2.3.4', '1.2.3.5'], 22, 20)).resolves.toBeDefined();
    expect(connectCalls).toHaveLength(2);
  });

  it('回收失败的 socket 时它自己抛错，也不该盖掉真正的原因', async () => {
    let attempt = 0;
    setConnect(() => {
      attempt += 1;
      return attempt === 1
        ? fakeSocket({ fail: new Error('连不上'), closeThrows: true })
        : fakeSocket();
    });
    await expect(openVerifiedSocket(['1.1.1.1', '1.1.1.2'], 22, 1000)).resolves.toBeDefined();
  });
});

describe('dialNode', () => {
  it('连私网目标在建 TCP 之前就被拦下', async () => {
    setConnect(() => fakeSocket());
    await expect(dialNode(env(), node({ host: '127.0.0.1' }), { onEnded: () => undefined }))
      .rejects.toThrow('已禁用私网/保留地址');
    expect(connectCalls).toHaveLength(0);
  });

  it('域名解析到私网同样被拦', async () => {
    const fetchMock = async () => ({
      ok: true,
      url: 'https://cloudflare-dns.com/dns-query?name=x&type=A',
      headers: new Headers({ 'Content-Type': 'application/dns-json' }),
      json: async () => ({ Status: 0, Answer: [{ type: 1, data: '10.1.2.3' }] }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(dialNode(env(), node({ host: 'inner.example' }), { onEnded: () => undefined }))
        .rejects.toThrow('解析到了私网/保留地址');
      expect(connectCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('公网字面量 IP 直接建连，地址与端口透传', async () => {
    setConnect(() => fakeSocket());
    const connection = await dialNode(env(), node({ host: '9.9.9.9', port: 22022 }), { onEnded: () => undefined });
    expect(connection).toBeInstanceOf(SSHConnection);
    expect(connectCalls).toEqual([
      { hostname: '9.9.9.9', port: 22022, options: { secureTransport: 'off', allowHalfOpen: false } },
    ]);
  });

  it('主机名首尾空格在建连前就被去掉（带空格会变成一次无意义的 DNS 查询）', async () => {
    setConnect(() => fakeSocket());
    await dialNode(env(), node({ host: '  9.9.9.9  ' }), { onEnded: () => undefined });
    expect(connectCalls[0]!.hostname).toBe('9.9.9.9');
  });

  it('IPv6 目标同样走方括号', async () => {
    setConnect(() => fakeSocket());
    await dialNode(env(), node({ host: '2606:4700:4700::1111' }), { onEnded: () => undefined });
    expect(connectCalls[0]!.hostname).toBe('[2606:4700:4700::1111]');
  });

  it('返回的连接尚未握手（握手预算由各入口自己控制）', async () => {
    setConnect(() => fakeSocket());
    const connection = await dialNode(env(), node(), { onEnded: () => undefined });
    expect(connection.isReady()).toBe(false);
  });

  it('把尺寸参数原样交给 buildNodeConfig（PTY 初始行列从这里下去）', async () => {
    setConnect(() => fakeSocket());
    spy.buildNodeConfig.mockClear();
    await dialNode(env(), node(), { cols: 143, rows: 37, onEnded: () => undefined });
    expect(spy.buildNodeConfig).toHaveBeenCalledWith(expect.objectContaining({ host: '1.2.3.4' }), 143, 37);
  });

  it('省略尺寸时交下去的是 undefined（由 node.ts 决定兜底值）', async () => {
    setConnect(() => fakeSocket());
    spy.buildNodeConfig.mockClear();
    await dialNode(env(), node(), { onEnded: () => undefined });
    expect(spy.buildNodeConfig).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
  });

  it('建连阶段不查主机密钥 —— 要到握手时才会碰 KV', async () => {
    setConnect(() => fakeSocket());
    const kv = { get: vi.fn(), put: vi.fn() };
    await dialNode(
      env({ HOST_KEY_MODE: 'tofu', MANAGI_KNOWN_HOSTS: kv as unknown as KVNamespace }),
      node(),
      { onEnded: () => undefined },
    );
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('TCP 建不起来时把底层错误原样抛上去', async () => {
    setConnect(() => fakeSocket({ fail: new Error('ECONNREFUSED') }));
    await expect(dialNode(env(), node(), { onEnded: () => undefined })).rejects.toThrow('ECONNREFUSED');
  });
});
