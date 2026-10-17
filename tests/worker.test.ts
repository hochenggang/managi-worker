import { afterEach, describe, expect, it, vi } from 'vitest';

// worker.ts 只做三件事：口令闸、路由、把工作交给静态资源。
// 这里不碰 SSH 层：Worker 已经不直接建连了。

import worker from '../src/worker';
import type { Env } from '../src/types';

const ORIGIN = 'https://managi.example';
const BASIC = `Basic ${btoa('ops:s3cret')}`;

/** b64 用 UTF-8 编码后再 base64（Node 的 btoa 只吃 latin1）。 */
function basicHeader(user: string, pass: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(`${user}:${pass}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

interface FakeAssets {
  fetch: ReturnType<typeof vi.fn>;
}

/**
 * upgradeResponse 伪造 DO 回给 Worker 的 101。
 * 不能写 `new Response(null, { status: 101 })`：Fetch 规范把 Response 构造器的
 * status 限定在 200-599，101 只有 workerd 内部才允许，在 Node 里会抛 RangeError
 * 并被顶层 catch 成 500。这里给一个够用的最小对象。
 */
function upgradeResponse(): Response {
  return { status: 101, headers: new Headers() } as unknown as Response;
}

function makeEnv(extra: Partial<Env> = {}, assets: FakeAssets | null = defaultAssets()): Env {
  const namespace = {
    get: vi.fn(() => ({ fetch: async () => upgradeResponse() })),
    newUniqueId: vi.fn(() => 'unique-id'),
  };
  return {
    ASSETS: (assets === null ? undefined : assets) as unknown as Fetcher,
    MANAGI_SESSIONS: namespace as unknown as DurableObjectNamespace,
    // 默认「公开访问」：口令已经是默认拒绝，绝大多数用例验的是路由而不是鉴权。
    // 需要验鉴权的用例各自覆盖 MANAGI_AUTH。
    MANAGI_AUTH: 'off',
    ...extra,
  } as unknown as Env;
}

function defaultAssets(): FakeAssets {
  return { fetch: vi.fn(async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`)) };
}

const call = (path: string, init: RequestInit = {}, env = makeEnv()): Promise<Response> =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

const postJson = (path: string, body: unknown, env = makeEnv(), headers: Record<string, string> = {}): Promise<Response> =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env);

afterEach(() => {
  vi.useRealTimers();
});

// ===== 口令闸 =====

describe('访问口令', () => {
  it('口令设为 off 时放行（显式开放）', async () => {
    const response = await call('/', {}, makeEnv({ MANAGI_AUTH: 'off' }));
    expect(response.status).toBe(200);
  });

  it('完全没配口令 → 503 并说明怎么配（默认拒绝，不再静默放行）', async () => {
    const response = await call('/', {}, makeEnv({ MANAGI_AUTH: '' }));
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; hint: string };
    expect(body.error).toContain('MANAGI_AUTH');
    // 这时候不能弹账号密码框：问题不在密码
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('配置了口令而请求没带凭据 → 401 + Basic 挑战', async () => {
    const response = await call('/', {}, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm="managi"');
    await expect(response.json()).resolves.toEqual({ error: '需要访问口令' });
  });

  it('口令不对 → 401', async () => {
    const response = await call('/', { headers: { Authorization: basicHeader('ops', 'nope') } }, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }));
    expect(response.status).toBe(401);
  });

  it('口令正确 → 200，并下发会话 Cookie', async () => {
    const response = await call('/', { headers: { Authorization: BASIC } }, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('managi_auth=');
  });

  it('带 Cookie 且不再带 Basic 也能过（WebSocket 握手只能靠它）', async () => {
    const env = makeEnv({ MANAGI_AUTH: 'ops:s3cret' });
    const first = await call('/', { headers: { Authorization: BASIC } }, env);
    const cookie = first.headers.get('Set-Cookie')!;
    const token = /managi_auth=([^;]+)/.exec(cookie)![1]!;
    const second = await call('/', { headers: { Cookie: `managi_auth=${token}` } }, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }));
    expect(second.status).toBe(200);
  });

  it('口令闸挡在静态资源前面（页面本身也不能白看）', async () => {
    const assets = defaultAssets();
    const response = await call('/index.html', {}, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }, assets));
    expect(response.status).toBe(401);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('口令闸也挡 /api 与 /ws', async () => {
    expect((await postJson('/api/ssh/batch', { nodes: [], cmds: [] }, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }))).status).toBe(401);
    const ws = await call('/ws', { headers: { Upgrade: 'websocket' } }, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }));
    expect(ws.status).toBe(401);
  });

  it('凭 Basic 进来时 /api 的成功响应也会续上会话 Cookie', async () => {
    const response = await call(
      '/api/version',
      { headers: { Authorization: BASIC } },
      makeEnv({ MANAGI_AUTH: 'ops:s3cret' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('managi_auth=');
  });

  it('口令闸挡在 /ws 之前，跨站 Origin 也过不了（先判口令再判出身）', async () => {
    const response = await call(
      '/ws',
      { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } },
      makeEnv({ MANAGI_AUTH: 'ops:s3cret' }),
    );
    expect(response.status).toBe(401);
  });
});

// ===== 静态资源兜底 =====

describe('静态资源兜底', () => {
  it('非 /ws 非 /api 的请求交给 [assets] 绑定', async () => {
    const assets = defaultAssets();
    const response = await call('/some/route', {}, makeEnv({}, assets));
    expect(await response.text()).toBe('asset:/some/route');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it('缺少 assets 绑定时明确报 503（而不是 500 或空响应）', async () => {
    const response = await call('/', {}, makeEnv({}, null));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: '静态资源绑定缺失（[assets] 未配置）' });
  });

  it('/api 前缀不会被静态资源吃掉', async () => {
    const assets = defaultAssets();
    await postJson('/api/nope', {}, makeEnv({}, assets));
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('静态资源自身抛错 → 500 并带上原因，而不是把异常漏出去', async () => {
    const assets: FakeAssets = { fetch: vi.fn(async () => { throw new Error('assets 崩了'); }) };
    const response = await call('/', {}, makeEnv({}, assets));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'assets 崩了' });
  });
});

// ===== WebSocket 升级 =====

describe('GET /ws', () => {
  const upgrade = { Upgrade: 'websocket', Origin: ORIGIN };

  it('非 GET → 405 且给出 Allow', async () => {
    const response = await call('/ws', { method: 'POST' }, makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('没有 Upgrade 头 → 426', async () => {
    const response = await call('/ws', {}, makeEnv());
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({ error: 'WebSocket upgrade required' });
  });

  it('跨站 Origin → 403（否则别的站点能借缓存的凭据开终端）', async () => {
    const response = await call('/ws', { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }, makeEnv());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'WebSocket origin is not allowed' });
  });

  it('同源 Origin → 101', async () => {
    const response = await call('/ws', { headers: upgrade }, makeEnv());
    expect(response.status).toBe(101);
  });

  it('非浏览器客户端（没有 Origin）放行', async () => {
    const response = await call('/ws', { headers: { Upgrade: 'websocket' } }, makeEnv());
    expect(response.status).toBe(101);
  });

  it('Upgrade 大小写不敏感', async () => {
    const response = await call('/ws', { headers: { Upgrade: 'WebSocket' } }, makeEnv());
    expect(response.status).toBe(101);
  });

  it('口令与 Cookie 不会转发给 Durable Object（它不需要知道，也就无从泄漏）', async () => {
    let forwarded: Request | null = null;
    const env = {
      ASSETS: defaultAssets(),
      MANAGI_SESSIONS: {
        get: () => ({ fetch: async (request: Request) => { forwarded = request; return upgradeResponse(); } }),
        newUniqueId: () => 'unique-id',
      },
      MANAGI_AUTH: 'off',
    } as unknown as Env;
    await call('/ws', { headers: { ...upgrade, Authorization: BASIC, Cookie: 'managi_auth=abc' } }, env);
    expect(forwarded).not.toBeNull();
    const request = forwarded as unknown as Request;
    expect(request.headers.get('Authorization')).toBeNull();
    expect(request.headers.get('Cookie')).toBeNull();
    expect(request.headers.get('Upgrade')?.toLowerCase()).toBe('websocket');
  });

  it('每次升级都拿一个新的 DO 实例（一条连接一个会话）', async () => {
    const newUniqueId = vi.fn(() => 'unique-id');
    const get = vi.fn(() => ({ fetch: async () => upgradeResponse() }));
    const env = { ASSETS: defaultAssets(), MANAGI_SESSIONS: { get, newUniqueId }, MANAGI_AUTH: 'off' } as unknown as Env;
    await call('/ws', { headers: upgrade }, env);
    await call('/ws', { headers: upgrade }, env);
    expect(newUniqueId).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

// ===== GET /api/version =====

describe('GET /api/version', () => {
  it('报出 wrangler 注入的部署身份', async () => {
    const response = await call('/api/version', {}, makeEnv({
      CF_VERSION_METADATA: { id: 'ver-1', tag: 'v1.2.3', timestamp: '2026-10-17T03:00:00Z' },
    }));
    expect(response.status).toBe(200);
    // 探针本身不能被缓存，否则看到的是上一版的答案
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      worker: 'managi-worker',
      deploy: { id: 'ver-1', tag: 'v1.2.3', timestamp: '2026-10-17T03:00:00Z' },
    });
  });

  it('没有版本绑定时 deploy 为 null，不编一个假版本', async () => {
    const response = await call('/api/version', {}, makeEnv());
    await expect(response.json()).resolves.toEqual({ worker: 'managi-worker', deploy: null });
  });

  it('同样受口令闸保护（不该白送部署信息）', async () => {
    const response = await call('/api/version', {}, makeEnv({ MANAGI_AUTH: 'ops:s3cret' }));
    expect(response.status).toBe(401);
  });
});

// ===== /api 通用规则 =====
//
// 现在只剩 /api/version 一条 GET。任何其它 /api 路径 —— 包括已删除的
// /api/ssh/batch 与 /api/sftp/download —— 都直说「不认识」，不装成 405。

describe('/api 未知路径', () => {
  it('未知路径 → 404，并把方法与路径回显出来', async () => {
    const response = await postJson('/api/nope', {});
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'unknown api path: POST /api/nope' });
  });

  it('已删除的批量/下载接口不再存在（旧前端会看到明确的 404）', async () => {
    for (const path of ['/api/ssh/batch', '/api/sftp/download']) {
      const response = await postJson(path, {});
      expect(response.status).toBe(404);
    }
  });

  it('错误响应一律不缓存', async () => {
    const response = await postJson('/api/nope', {});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
