import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// worker.ts 只做三件事：口令闸、路由、把工作交给 SSH 层。
// 所以这里把 dial 与三个通道处理器整体换掉 —— 验收的是 HTTP 语义与分发规则，
// SSH 协议栈与通道编排各有自己的用例。
const mocks = vi.hoisted(() => ({ dialNode: vi.fn() }));

vi.mock('../src/dial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dial')>();
  return { ...actual, dialNode: (...args: unknown[]) => mocks.dialNode(...args) };
});

vi.mock('../src/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session')>();
  const { FakeConnection, FakeExecHandler, FakeSFTPHandler } = await import('./fakes');
  return {
    ...actual,
    SSHConnection: FakeConnection,
    ExecHandler: FakeExecHandler,
    SFTPHandler: FakeSFTPHandler,
  };
});

import worker from '../src/worker';
import { SSHAuthDefectError } from '../src/session';
import type { Env } from '../src/types';
import { FakeConnection, FakeExecHandler, FakeSFTPHandler, type FakeSFTPPlan } from './fakes';

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

const NODE = { host: '1.2.3.4', port: 22, username: 'root', auth_type: 'password', auth_value: 'pw' };

let connection: FakeConnection;

beforeEach(() => {
  FakeExecHandler.reset();
  FakeSFTPHandler.reset();
  connection = new FakeConnection();
  mocks.dialNode.mockResolvedValue(connection);
});

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
    const response = await postJson(
      '/api/ssh/batch',
      { nodes: [], cmds: [] },
      makeEnv({ MANAGI_AUTH: 'ops:s3cret' }),
      { Authorization: BASIC },
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

describe('/api 通用规则', () => {
  it('非 POST → 405 且给出 Allow', async () => {
    const response = await call('/api/ssh/batch', {}, makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('未知路径 → 404，且把路径回显出来', async () => {
    const response = await postJson('/api/nope', {}, makeEnv());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'unknown api path: POST /api/nope' });
  });

  it('跨站请求被拒（浏览器会自动带上 Basic 凭据，写操作必须看出身）', async () => {
    const response = await postJson('/api/ssh/batch', {}, makeEnv(), { 'Sec-Fetch-Site': 'cross-site' });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'cross-site request rejected' });
  });

  it('同源与 none（curl 等非浏览器）放行', async () => {
    for (const site of ['same-origin', 'none']) {
      const response = await postJson('/api/ssh/batch', { nodes: [], cmds: [] }, makeEnv(), { 'Sec-Fetch-Site': site });
      expect(response.status).toBe(200);
    }
  });

  it('没有 Sec-Fetch-Site 头的老客户端也放行', async () => {
    const response = await postJson('/api/ssh/batch', { nodes: [], cmds: [] }, makeEnv());
    expect(response.status).toBe(200);
  });

  it('请求体不是 JSON → 400', async () => {
    const response = await postJson('/api/ssh/batch', '这不是 json', makeEnv());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  it('Content-Length 一上来就超标 → 413，不去读正文', async () => {
    const response = await postJson('/api/ssh/batch', {}, makeEnv(), { 'Content-Length': String(20 << 20) });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: '请求体过大' });
  });

  it('错误响应一律不缓存', async () => {
    const response = await postJson('/api/nope', {}, makeEnv());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ===== POST /api/ssh/batch =====

describe('POST /api/ssh/batch', () => {
  const batch = (body: unknown, env = makeEnv(), headers?: Record<string, string>) =>
    postJson('/api/ssh/batch', body, env, headers);

  it('nodes 不是数组 → 400', async () => {
    const response = await batch({ nodes: 'x', cmds: [] });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'nodes 必须是数组' });
  });

  it('cmds 不是字符串数组 → 400', async () => {
    expect((await batch({ nodes: [], cmds: 'ls' })).status).toBe(400);
    expect((await batch({ nodes: [], cmds: [1, 2] })).status).toBe(400);
  });

  it('节点数超过 100 → 400', async () => {
    const nodes = Array.from({ length: 101 }, () => NODE);
    const response = await batch({ nodes, cmds: ['ls'] });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '节点数超过上限（最多 100 个）' });
  });

  it('空数组立刻返回空结果，不去连任何机器', async () => {
    const response = await batch({ nodes: [], cmds: ['ls'] });
    expect(await response.json()).toEqual([]);
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('没有命令时视为「没什么可失败」，直接回空成功', async () => {
    const response = await batch({ nodes: [NODE], cmds: [] });
    const results = (await response.json()) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.output).toEqual([]);
    expect(results[0]!.error).toEqual([]);
    expect(results[0]!.cmds).toBe('');
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('多条命令按换行合成一段脚本，在同一个 shell 里顺序执行', async () => {
    const pending = batch({ nodes: [NODE], cmds: ['cd /tmp', 'ls', 'echo ok'] });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(1));
    expect(FakeExecHandler.created[0]!.command).toBe('cd /tmp\nls\necho ok');
    FakeExecHandler.created[0]!.finish({ stdout: '', stderr: '', exitStatus: 0 });
    await pending;
  });

  it('成功时把 stdout 按行拆开，凭据打码，耗时给出来', async () => {
    const pending = batch({ nodes: [NODE], cmds: ['ls'] });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(1));
    FakeExecHandler.created[0]!.finish({ stdout: 'a\nb\n', stderr: '', exitStatus: 0 });
    const results = (await (await pending).json()) as Array<Record<string, unknown>>;
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.output).toEqual(['a', 'b']);
    expect(results[0]!.error).toEqual([]);
    expect(results[0]!.time_elapsed).toBeTypeOf('number');
    expect((results[0]!.node as Record<string, unknown>).auth_value).toBe('***');
  });

  it('有 stderr 即视为失败，stderr 按行进 error', async () => {
    const pending = batch({ nodes: [NODE], cmds: ['ls'] });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(1));
    FakeExecHandler.created[0]!.finish({ stdout: 'ok\n', stderr: 'permission denied\n', exitStatus: 1 });
    const results = (await (await pending).json()) as Array<Record<string, unknown>>;
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toEqual(['permission denied']);
  });

  it('输出被截断时补一行提示，且仍算成功（是展示限制不是命令失败）', async () => {
    const pending = batch({ nodes: [NODE], cmds: ['yes'] });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(1));
    FakeExecHandler.created[0]!.finish({
      stdout: 'a\n', stderr: '', exitStatus: 0, stdoutTruncated: true, stderrTruncated: true,
    });
    const results = (await (await pending).json()) as Array<Record<string, unknown>>;
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.output).toEqual(['a', '[managi] stdout 输出超过 4MB，已截断', '[managi] stderr 输出超过 4MB，已截断']);
  });

  it('单个节点连不上时只在它自己的结果里报错，别的节点照跑', async () => {
    mocks.dialNode.mockImplementation(async (_env: unknown, node: { host: string }) => {
      if (node.host === 'bad.example') throw new Error('TCP 连接超时');
      return connection;
    });
    const pending = batch({
      nodes: [NODE, { ...NODE, host: 'bad.example' }, { ...NODE, host: '3.3.3.3' }],
      cmds: ['ls'],
    });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(2));
    for (const handler of FakeExecHandler.created) handler.finish({ stdout: 'ok\n', stderr: '', exitStatus: 0 });
    const results = (await (await pending).json()) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toEqual(['bad.example:22 — TCP 连接超时']);
    expect(results[2]!.success).toBe(true);
  });

  it('结果顺序与输入节点顺序一致（快的不能插队）', async () => {
    const slow = new FakeConnection();
    mocks.dialNode.mockImplementation(async (_env: unknown, node: { host: string }) =>
      node.host === 'slow.example' ? slow : new FakeConnection());
    const pending = batch({
      nodes: [{ ...NODE, host: 'slow.example' }, { ...NODE, host: 'fast.example' }],
      cmds: ['ls'],
    });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(2));
    // 先让「后一个」节点出结果，再让前一个出：结果数组仍须按输入顺序摆。
    FakeExecHandler.created[1]!.finish({ stdout: 'second\n', stderr: '', exitStatus: 0 });
    FakeExecHandler.created[0]!.finish({ stdout: 'first\n', stderr: '', exitStatus: 0 });
    const results = (await (await pending).json()) as Array<Record<string, unknown>>;
    expect(results[0]!.output).toEqual(['first']);
    expect(results[1]!.output).toEqual(['second']);
  });

  it('凭据被拒时原样报出原因，不硬套上 主机:端口 前缀', async () => {
    mocks.dialNode.mockRejectedValue(new SSHAuthDefectError('SSH 认证失败：用户名、密码或私钥不正确'));
    const response = await batch({ nodes: [NODE], cmds: ['ls'] });
    const results = (await response.json()) as Array<Record<string, unknown>>;
    expect(results[0]!.error).toEqual(['SSH 认证失败：用户名、密码或私钥不正确']);
  });

  it('节点描述不合法时给出具体原因', async () => {
    const response = await batch({ nodes: [{ ...NODE, port: 70000 }], cmds: ['ls'] });
    const results = (await response.json()) as Array<Record<string, unknown>>;
    expect(results[0]!.success).toBe(false);
    expect(String(results[0]!.error)).toContain('端口 70000 非法');
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('执行超时时报「已终止」，而不是把半截输出当成结果', async () => {
    vi.useFakeTimers();
    const pending = batch({ nodes: [NODE], cmds: ['sleep 9999'] });
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    const results = (await (await pending).json()) as Array<Record<string, unknown>>;
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toEqual(['命令执行超时（上限 15 分钟），已终止']);
    expect(connection.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('拿到的输出上限是 4MB（与 Go 版一致）', async () => {
    const pending = batch({ nodes: [NODE], cmds: ['ls'] });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(1));
    expect(FakeExecHandler.created[0]!.maxBytes).toBe(4 << 20);
    FakeExecHandler.created[0]!.finish({ stdout: '', stderr: '', exitStatus: 0 });
    await pending;
  });

  it('每个节点都单独建连（不复用连接池）', async () => {
    mocks.dialNode.mockImplementation(async () => new FakeConnection());
    const pending = batch({ nodes: [NODE, { ...NODE, host: '2.2.2.2' }], cmds: ['ls'] });
    await vi.waitFor(() => expect(FakeExecHandler.created).toHaveLength(2));
    for (const handler of FakeExecHandler.created) handler.finish({ stdout: '', stderr: '', exitStatus: 0 });
    await pending;
    expect(mocks.dialNode).toHaveBeenCalledTimes(2);
  });

  it('通道开不起来时立刻失败，不必等到 15 分钟超时', async () => {
    const broken = new FakeConnection();
    broken.openExec = () => { throw new Error('通道开不了'); };
    mocks.dialNode.mockResolvedValue(broken);
    const results = (await (await batch({ nodes: [NODE], cmds: ['ls'] })).json()) as Array<Record<string, unknown>>;
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toEqual(['1.2.3.4:22 — 通道开不了']);
  });
});

// ===== POST /api/sftp/download =====

describe('POST /api/sftp/download', () => {
  const download = (body: unknown, env = makeEnv(), headers?: Record<string, string>) =>
    postJson('/api/sftp/download', body, env, headers);

  /**
   * prepare 先把假通道的配置放好，再发请求。
   * 通道一就绪 download() 就被 await 了，用例来不及事后改实例字段 ——
   * 所以一律通过静态 plan 提前注入（见 fakes.ts 的 FakeSFTPPlan）。
   */
  async function prepare(
    plan: FakeSFTPPlan,
    body: unknown = { node: NODE, path: '/tmp/report.csv' },
    headers?: Record<string, string>,
  ): Promise<{ response: Response; handler: FakeSFTPHandler }> {
    FakeSFTPHandler.plan = plan;
    const response = await download(body, makeEnv(), headers);
    return { response, handler: FakeSFTPHandler.created[0]! };
  }

  /** fileMeta 造一份下载计划：filename + 总长度 + 分片大小（默认一整片）。 */
  const fileMeta = (filename: string, total: number, chunks: number[] = [total]): FakeSFTPPlan => ({
    downloadMeta: { filename, total, chunks: chunks.map((size) => new Uint8Array(size)) },
  });

  it('缺 path → 400', async () => {
    expect((await download({ node: NODE })).status).toBe(400);
    expect((await download({ node: NODE, path: '' })).status).toBe(400);
    expect((await download({ node: NODE, path: 42 })).status).toBe(400);
  });

  it('节点不合法 → 400（这里不复用批量那套「结果对象」）', async () => {
    const response = await download({ node: { ...NODE, host: '' }, path: '/a' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '节点地址(host)为空' });
    expect(mocks.dialNode).not.toHaveBeenCalled();
  });

  it('建连失败 → 502，并把原因带上', async () => {
    mocks.dialNode.mockRejectedValue(new Error('已禁用私网/保留地址作为 SSH 目标'));
    const response = await download({ node: NODE, path: '/a' });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: '已禁用私网/保留地址作为 SSH 目标' });
  });

  it('SFTP 子系统起不来 → 502', async () => {
    const { response } = await prepare({ readyFailure: '服务器拒绝了 SFTP 子系统' }, { node: NODE, path: '/a' });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: '服务器拒绝了 SFTP 子系统' });
  });

  it('远端文件读不到 → 502', async () => {
    const { response } = await prepare({ downloadError: new Error('no such file') }, { node: NODE, path: '/a' });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'no such file' });
  });

  it('成功时给出完整的下载响应头', async () => {
    const { response } = await prepare(fileMeta('report.csv', 10));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-9/10');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Disposition')).toContain('attachment; filename="report.csv"');
    await response.arrayBuffer();
  });

  it('响应先出、数据后走（顺序反了前端就不知道这堆字节是谁的）', async () => {
    const { response, handler } = await prepare(fileMeta('report.csv', 10));
    // 拿到响应时 start() 已经跑过了 —— 说明控制信息确实排在数据之前。
    expect(handler.started).toBe(1);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  });

  it('正文按分片流式下发', async () => {
    const { response } = await prepare(fileMeta('report.csv', 10, [4, 6]));
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  });

  it('带 Range 头 → 206，并从该偏移开始推、长度按剩下的算', async () => {
    const { response, handler } = await prepare(fileMeta('report.csv', 10, [6]), undefined, { Range: 'bytes=4-' });
    expect(response.status).toBe(206);
    expect(handler.downloadCalls[0]!.offset).toBe(4);
    expect(response.headers.get('Content-Length')).toBe('6');
    expect(response.headers.get('Content-Range')).toBe('bytes 4-9/10');
    expect((await response.arrayBuffer()).byteLength).toBe(6);
  });

  // 之前这里只认 `bytes=N-`：带上终点的请求被当成「从 N 到文件尾」，
  // 分包续传的每一片都会收到整个文件 —— 拼出来的文件必然错位。
  it('bytes=N-M 只推这一段（终点必须被尊重）', async () => {
    const { response, handler } = await prepare(fileMeta('report.csv', 10, [5]), undefined, { Range: 'bytes=2-6' });
    expect(response.status).toBe(206);
    expect(handler.downloadCalls[0]).toMatchObject({ offset: 2, endOffset: 6 });
    expect(response.headers.get('Content-Length')).toBe('5');
    expect(response.headers.get('Content-Range')).toBe('bytes 2-6/10');
    expect((await response.arrayBuffer()).byteLength).toBe(5);
  });

  it('bytes=-N 是「最后 N 字节」，不是从负数开始', async () => {
    const { response, handler } = await prepare(fileMeta('report.csv', 10, [4]), undefined, { Range: 'bytes=-4' });
    expect(response.status).toBe(206);
    expect(handler.downloadCalls[0]).toMatchObject({ offset: 6, endOffset: 9 });
    expect(response.headers.get('Content-Range')).toBe('bytes 6-9/10');
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });

  it('终点超过文件尾按文件尾算（RFC 允许）', async () => {
    const beyond = await prepare(fileMeta('report.csv', 4, [4]), undefined, { Range: 'bytes=2-999' });
    expect(beyond.response.status).toBe(206);
    expect(beyond.response.headers.get('Content-Range')).toBe('bytes 2-3/4');
  });

  it('起点越界 → 416 + `bytes */total`，且不去开文件', async () => {
    const invalid = await prepare(fileMeta('report.csv', 4, []), undefined, { Range: 'bytes=9-' });
    expect(invalid.response.status).toBe(416);
    // 416 必须带 `bytes */total`，客户端才知道真实长度
    expect(invalid.response.headers.get('Content-Range')).toBe('bytes */4');
    expect(invalid.handler.statSizeCalls).toEqual(['/tmp/report.csv']);
    expect(invalid.handler.downloadCalls).toHaveLength(0);
  });

  it('不认识的 Range 形式按规范忽略该头：回 200 + 整份', async () => {
    const { response, handler } = await prepare(fileMeta('report.csv', 3, [3]), undefined, { Range: 'items=1-2' });
    expect(handler.downloadCalls[0]!.offset).toBe(0);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('3');
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  });

  it('Range 偏移大到超出安全整数 → 忽略该头，退回整份（不拿会被静默取整的数去读文件）', async () => {
    const { response, handler } = await prepare(fileMeta('report.csv', 3, [3]), undefined, {
      Range: 'bytes=99999999999999999999-',
    });
    expect(handler.downloadCalls[0]!.offset).toBe(0);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-2/3');
    await response.arrayBuffer();
  });

  it('空文件时 Content-Range 不会出现负数', async () => {
    const { response } = await prepare(fileMeta('empty', 0, []));
    expect(response.headers.get('Content-Length')).toBe('0');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-0/0');
    await response.arrayBuffer();
  });

  it('文件名含中文时给 ASCII 兜底 + RFC 5987 的真名', async () => {
    const { response } = await prepare(fileMeta('报告 2026.csv', 1, [1]));
    const disposition = response.headers.get('Content-Disposition')!;
    expect(disposition).toContain('filename="');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent('报告 2026.csv'));
    expect(disposition).not.toMatch(/filename="[^"]*[^\x20-\x7e][^"]*"/);
    await response.arrayBuffer();
  });

  it('引号与反斜杠不会破坏头部（防头注入）', async () => {
    const { response } = await prepare(fileMeta('a"b\\c.txt', 1, [1]));
    expect(response.headers.get('Content-Disposition')!.split(';')[0]).toBe('attachment');
    await response.arrayBuffer();
  });

  it('下载失败后连接会被收掉（不留一个挂着的 SSH 连接）', async () => {
    await prepare({ downloadError: new Error('读不了') }, { node: NODE, path: '/a' });
    expect(connection.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('推到一半远端报错 → 流被断掉，也不会把半截字节当完整文件交出去', async () => {
    const { response, handler } = await prepare({
      downloadMeta: { filename: 'a.bin', total: 10, chunks: [new Uint8Array(4)], stayOpen: true },
    });
    expect(response.status).toBe(200);
    const body = response.arrayBuffer();
    handler.cb.error('远端读写错误');
    await expect(body).rejects.toThrow('远端读写错误');
    expect(connection.closeCount).toBeGreaterThanOrEqual(1);
  });
});
