import { describe, expect, it, vi } from 'vitest';
import { hostKeyMode, verifyHostKey } from '../src/host-keys';

/**
 * 假 KV。注意 host-keys 里有一个模块级的「已查过」记忆（带 60 秒 TTL），
 * 跨用例不会自动清 —— 所以每个用例都用**互不相同的主机名**，从根上避开串味。
 */
interface FakeKV {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

function fakeKV(initial: Record<string, string> = {}): FakeKV {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
  };
}

const asKV = (kv: FakeKV): KVNamespace => kv as unknown as KVNamespace;

const FP_A = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FP_B = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('hostKeyMode', () => {
  it('只有明确写 off 才关闭校验，其余一律 tofu（默认安全）', () => {
    expect(hostKeyMode('off')).toBe('off');
    expect(hostKeyMode(undefined)).toBe('tofu');
    expect(hostKeyMode('tofu')).toBe('tofu');
    expect(hostKeyMode('OFF')).toBe('tofu');
    expect(hostKeyMode('')).toBe('tofu');
    expect(hostKeyMode('随便写的')).toBe('tofu');
  });
});

describe('verifyHostKey —— 不校验的情形', () => {
  it('mode=off 时直接放行，连 KV 都不碰', async () => {
    const kv = fakeKV();
    await expect(verifyHostKey(asKV(kv), 'off', 'off.example', 22, FP_A))
      .resolves.toEqual({ ok: true, recorded: false });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('没绑 KV（本地 dev 常见）时放行并告警，不阻断使用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(verifyHostKey(undefined, 'tofu', 'nokv.example', 22, FP_A))
      .resolves.toEqual({ ok: true, recorded: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('未绑定 MANAGI_KNOWN_HOSTS');
  });
});

describe('verifyHostKey —— 首次记录（TOFU）', () => {
  it('没有记录时写下指纹，并标记为本次新记录', async () => {
    const kv = fakeKV();
    const result = await verifyHostKey(asKV(kv), 'tofu', 'first.example', 22, FP_A);
    expect(result).toEqual({ ok: true, recorded: true });
    expect(kv.put).toHaveBeenCalledWith('hostkey:first.example:22', FP_A);
    expect(kv.store.get('hostkey:first.example:22')).toBe(FP_A);
  });

  it('KV 键按小写主机名归一（同一台机器不同大小写只算一条）', async () => {
    const kv = fakeKV();
    await verifyHostKey(asKV(kv), 'tofu', 'MiXeD.Example', 2222, FP_A);
    expect(kv.put).toHaveBeenCalledWith('hostkey:mixed.example:2222', FP_A);
  });

  it('端口进键，同一主机的不同端口各自记一条', async () => {
    const kv = fakeKV();
    await verifyHostKey(asKV(kv), 'tofu', 'ports.example', 22, FP_A);
    await verifyHostKey(asKV(kv), 'tofu', 'ports.example', 2222, FP_B);
    expect([...kv.store.keys()].sort()).toEqual([
      'hostkey:ports.example:22',
      'hostkey:ports.example:2222',
    ]);
  });

  it('写入 KV 失败时放行（不能让存储故障变成连不上机器）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = fakeKV();
    kv.put.mockRejectedValueOnce(new Error('KV 写挂了'));
    await expect(verifyHostKey(asKV(kv), 'tofu', 'putfail.example', 22, FP_A))
      .resolves.toEqual({ ok: true, recorded: true });
    expect(String(warn.mock.calls[0]?.[0])).toContain('记录主机密钥失败');
  });

  it('读取 KV 失败时放行（同上，下次再说）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = fakeKV();
    kv.get.mockRejectedValueOnce(new Error('KV 读挂了'));
    await expect(verifyHostKey(asKV(kv), 'tofu', 'getfail.example', 22, FP_A))
      .resolves.toEqual({ ok: true, recorded: false });
    expect(String(warn.mock.calls[0]?.[0])).toContain('读取已知主机密钥失败');
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe('verifyHostKey —— 已有记录的比对', () => {
  it('指纹一致时通过', async () => {
    const kv = fakeKV({ 'hostkey:match.example:22': FP_A });
    await expect(verifyHostKey(asKV(kv), 'tofu', 'match.example', 22, FP_A))
      .resolves.toEqual({ ok: true, recorded: false });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('指纹不一致时拒绝，并把两边指纹、以及怎么重新信任都写进原因里', async () => {
    const kv = fakeKV({ 'hostkey:changed.example:22': FP_A });
    const result = await verifyHostKey(asKV(kv), 'tofu', 'changed.example', 22, FP_B);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('主机密钥与记录不一致');
    expect(result.reason).toContain(FP_A);
    expect(result.reason).toContain(FP_B);
    expect(result.reason).toContain('hostkey:changed.example:22');
  });
});

describe('verifyHostKey —— isolate 内记忆（带 TTL）', () => {
  it('同一目标第二次不再查 KV', async () => {
    const kv = fakeKV();
    await verifyHostKey(asKV(kv), 'tofu', 'memo.example', 22, FP_A);
    await verifyHostKey(asKV(kv), 'tofu', 'memo.example', 22, FP_A);
    await verifyHostKey(asKV(kv), 'tofu', 'memo.example', 22, FP_A);
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('记忆里指纹不同也照样拒绝（不会因为缓存而放行）', async () => {
    const kv = fakeKV();
    await verifyHostKey(asKV(kv), 'tofu', 'memochanged.example', 22, FP_A);
    const second = await verifyHostKey(asKV(kv), 'tofu', 'memochanged.example', 22, FP_B);
    expect(second.ok).toBe(false);
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('记忆过期后会重新查 KV —— 控制台删键才可能即时生效', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const kv = fakeKV();
      await verifyHostKey(asKV(kv), 'tofu', 'ttl.example', 22, FP_A);
      expect(kv.get).toHaveBeenCalledTimes(1);

      // 模拟用户按 README 删掉 KV 键、服务器换了新密钥：记忆必须过期才会看到变化。
      kv.store.delete('hostkey:ttl.example:22');
      vi.setSystemTime(new Date(Date.now() + 61_000));

      await expect(verifyHostKey(asKV(kv), 'tofu', 'ttl.example', 22, FP_B))
        .resolves.toEqual({ ok: true, recorded: true });
      expect(kv.get).toHaveBeenCalledTimes(2);
      expect(kv.store.get('hostkey:ttl.example:22')).toBe(FP_B);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL 之内仍然吃记忆（同一波重连不该被 KV 往返拖慢）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const kv = fakeKV();
      await verifyHostKey(asKV(kv), 'tofu', 'ttlfresh.example', 22, FP_A);
      kv.store.delete('hostkey:ttlfresh.example:22');
      vi.setSystemTime(new Date(Date.now() + 30_000));
      await expect(verifyHostKey(asKV(kv), 'tofu', 'ttlfresh.example', 22, FP_A))
        .resolves.toEqual({ ok: true, recorded: false });
      expect(kv.get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
