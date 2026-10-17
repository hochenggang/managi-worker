import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAuth, unauthorizedResponse } from '../src/auth';
import type { Env } from '../src/types';

type AnyEnv = Env;

const env = (auth?: string): AnyEnv => ({ MANAGI_AUTH: auth } as unknown as AnyEnv);

function req(headers: Record<string, string> = {}, url = 'https://managi.example/'): Request {
  return new Request(url, { headers });
}

/** b64 手写标准 base64（不引 Buffer，测试文件也要能在 Worker 类型环境下编译）。 */
function b64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const basic = (user: string, pass: string): string => `Basic ${b64(`${user}:${pass}`)}`;

function tokenOf(setCookie: string): string {
  const match = /^managi_auth=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Set-Cookie 不符合预期：${setCookie}`);
  return match[1]!;
}

/** issue 走一遍「正确口令」的流程，拿到那枚会话 Cookie 的值。 */
async function issueCookie(auth: string, url = 'https://managi.example/'): Promise<string> {
  const [user, pass] = auth.split(':');
  const outcome = await checkAuth(req({ Authorization: basic(user!, pass!) }, url), env(auth));
  expect(outcome.ok).toBe(true);
  expect(outcome.setCookie).toBeDefined();
  return tokenOf(outcome.setCookie!);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('checkAuth —— 未配置口令（回落到默认 admin:admin）', () => {
  it('没配 → 默认口令可用：admin / admin 直接进，并下发 Cookie', async () => {
    const outcome = await checkAuth(req({ Authorization: basic('admin', 'admin') }), env(undefined));
    expect(outcome.ok).toBe(true);
    expect(outcome.setCookie).toBeDefined();
  });

  it('空串与纯空白同样回落（部署时填了空值也算没配）', async () => {
    for (const value of [undefined, '', '   ']) {
      const outcome = await checkAuth(req({ Authorization: basic('admin', 'admin') }), env(value));
      expect(outcome.ok).toBe(true);
    }
  });

  it('默认口令之外的凭据仍然进不来', async () => {
    for (const [user, pass] of [['admin', 'admin1'], ['root', 'admin'], ['admin', '']] as const) {
      const outcome = await checkAuth(req({ Authorization: basic(user, pass) }), env(''));
      expect(outcome.ok).toBe(false);
    }
  });

  it('显式设为 off / none 才开放（大小写与空白无所谓）', async () => {
    for (const value of ['off', 'OFF', ' none ']) {
      await expect(checkAuth(req(), env(value))).resolves.toEqual({ ok: true });
    }
  });

  it('用默认口令时告警一次（否则每个请求都刷一行日志）', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fresh = await import('../src/auth');
      await fresh.checkAuth(req(), env(undefined));
      await fresh.checkAuth(req(), env(undefined));
      await fresh.checkAuth(req(), env(undefined));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('admin:admin');
    } finally {
      warn.mockRestore();
    }
  });

  it('配了自己的口令就不告警', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fresh = await import('../src/auth');
      await fresh.checkAuth(req(), env('ops:s3cret'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('unauthorizedResponse', () => {
  it('口令不对 → 401 + Basic 挑战', () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm=');
  });
});

describe('checkAuth —— Basic 凭据', () => {
  it('口令正确时通过，并顺手发一枚会话 Cookie', async () => {
    const outcome = await checkAuth(req({ Authorization: basic('ops', 's3cret') }), env('ops:s3cret'));
    expect(outcome.ok).toBe(true);
    expect(outcome.setCookie).toContain('managi_auth=');
  });

  it('口令错、用户名错、两者都错都不通过', async () => {
    const e = env('ops:s3cret');
    expect((await checkAuth(req({ Authorization: basic('ops', 'wrong') }), e)).ok).toBe(false);
    expect((await checkAuth(req({ Authorization: basic('wrong', 's3cret') }), e)).ok).toBe(false);
    expect((await checkAuth(req({ Authorization: basic('a', 'b') }), e)).ok).toBe(false);
  });

  it('按 UTF-8 字节比对，口令里有中文也对得上', async () => {
    const auth = '运维:口令是中文';
    const outcome = await checkAuth(req({ Authorization: basic('运维', '口令是中文') }), env(auth));
    expect(outcome.ok).toBe(true);
  });

  it('大小写不匹配的口令不通过（不做任何归一）', async () => {
    expect((await checkAuth(req({ Authorization: basic('ops', 'S3CRET') }), env('ops:s3cret'))).ok).toBe(false);
  });

  it('方案名大小写不敏感，前后的空白也无所谓', async () => {
    const outcome = await checkAuth(req({ Authorization: `  basic ${b64('ops:s3cret')}  ` }), env('ops:s3cret'));
    expect(outcome.ok).toBe(true);
  });

  it('不是 Basic 方案、格式不对、base64 坏掉一律不通过', async () => {
    const e = env('ops:s3cret');
    expect((await checkAuth(req({ Authorization: 'Bearer abc' }), e)).ok).toBe(false);
    expect((await checkAuth(req({ Authorization: 'Basic' }), e)).ok).toBe(false);
    expect((await checkAuth(req({ Authorization: 'Basic a b' }), e)).ok).toBe(false);
    expect((await checkAuth(req({ Authorization: 'Basic !!!not-base64!!!' }), e)).ok).toBe(false);
    expect((await checkAuth(req(), e)).ok).toBe(false);
  });

  it('口令里没有冒号时用户名回退成 admin（与 Go 版默认值一致）', async () => {
    expect((await checkAuth(req({ Authorization: basic('admin', 'onlypass') }), env('onlypass'))).ok).toBe(true);
    expect((await checkAuth(req({ Authorization: basic('someone', 'onlypass') }), env('onlypass'))).ok).toBe(false);
  });

  it('口令以冒号开头时用户名同样回退成 admin', async () => {
    expect((await checkAuth(req({ Authorization: basic('admin', 'pw') }), env(':pw'))).ok).toBe(true);
  });

  it('只发 Basic 时不带 Cookie 头也没关系', async () => {
    const outcome = await checkAuth(req({ Authorization: basic('ops', 's3cret') }), env('ops:s3cret'));
    expect(outcome.ok).toBe(true);
  });
});

describe('checkAuth —— 会话 Cookie', () => {
  const auth = 'ops:s3cret';

  it('凭 Cookie 单独就能通过，并且不再重发 Cookie', async () => {
    const token = await issueCookie(auth);
    const outcome = await checkAuth(req({ Cookie: `managi_auth=${token}` }), env(auth));
    expect(outcome.ok).toBe(true);
    expect(outcome.setCookie).toBeUndefined();
  });

  it('Cookie 混在一堆其它 Cookie 里也能挑出来', async () => {
    const token = await issueCookie(auth);
    const header = `theme=dark; managi_auth=${token}; lang=zh`;
    await expect(checkAuth(req({ Cookie: header }), env(auth))).resolves.toEqual({ ok: true });
  });

  it('改掉签名里的任何一个字符都不通过', async () => {
    const token = await issueCookie(auth);
    const [expiry, signature] = token.split('.');
    // 必须翻**第一个**字符：HMAC-SHA256 的 base64url 签名是 43 个字符，
    // 最后一个字符只承载 4 个有效位、另 2 位是编码填充位，换成 'A'/'B' 解码结果相同 ——
    // 拿它做「改一个字符就应失效」会在约 1/16 的情况下假通过（实测撞到过一次）。
    const flipped = `${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    expect(flipped).not.toBe(signature);
    expect((await checkAuth(req({ Cookie: `managi_auth=${expiry}.${flipped}` }), env(auth))).ok).toBe(false);
  });

  it('改掉过期时间不通过（签名把时间也一起保护了）', async () => {
    const token = await issueCookie(auth);
    const signature = token.slice(token.indexOf('.') + 1);
    const farFuture = Date.now() + 365 * 24 * 3600 * 1000;
    expect((await checkAuth(req({ Cookie: `managi_auth=${farFuture}.${signature}` }), env(auth))).ok).toBe(false);
  });

  it('换一个口令后旧 Cookie 立即失效（无需任何撤销表）', async () => {
    const token = await issueCookie(auth);
    expect((await checkAuth(req({ Cookie: `managi_auth=${token}` }), env('ops:another'))).ok).toBe(false);
  });

  it('过期后不通过', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = await issueCookie(auth);
    expect((await checkAuth(req({ Cookie: `managi_auth=${token}` }), env(auth))).ok).toBe(true);
    // Cookie 有效期 7 天，拨到第 8 天。
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 3600 * 1000));
    expect((await checkAuth(req({ Cookie: `managi_auth=${token}` }), env(auth))).ok).toBe(false);
  });

  it('形状不对的 Cookie 一律不通过', async () => {
    const e = env(auth);
    const bad = [
      'managi_auth=',
      'managi_auth=nodot',
      'managi_auth=.signature',
      'managi_auth=abc.def',
      'managi_auth=1.2.3',
      'managi_auth=abc.!!!',
      `managi_auth=${'9'.repeat(400)}.sig`,
    ];
    for (const cookie of bad) {
      expect((await checkAuth(req({ Cookie: cookie }), e)).ok, cookie).toBe(false);
    }
  });

  it('名字对不上的 Cookie 不算数', async () => {
    const token = await issueCookie(auth);
    expect((await checkAuth(req({ Cookie: `not_managi_auth=${token}` }), env(auth))).ok).toBe(false);
  });

  it('过期时间合法但签名不是 base64url → 不通过（解不出来按失败处理）', async () => {
    // 时间戳必须先是合法整数，才轮得到签名这一步 —— 否则测的是前面那道闸。
    const upcoming = Date.now() + 60_000;
    expect((await checkAuth(req({ Cookie: `managi_auth=${upcoming}.!!!` }), env(auth))).ok).toBe(false);
    expect((await checkAuth(req({ Cookie: `managi_auth=${upcoming}.` }), env(auth))).ok).toBe(false);
  });

  it('同时给了坏 Cookie 和好 Basic：也通过（Basic 那条路仍然有效）', async () => {
    const outcome = await checkAuth(
      req({ Cookie: 'managi_auth=bogus.sig', Authorization: basic('ops', 's3cret') }),
      env(auth),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.setCookie).toBeDefined();
  });
});

describe('issueCookie 的下发属性（借 checkAuth 观察）', () => {
  it('HttpOnly + SameSite=Strict + Path=/ + 7 天有效期', async () => {
    const outcome = await checkAuth(req({ Authorization: basic('ops', 's3cret') }), env('ops:s3cret'));
    const cookie = outcome.setCookie!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${7 * 24 * 3600}`);
  });

  it('https 下带 Secure', async () => {
    const outcome = await checkAuth(
      req({ Authorization: basic('ops', 's3cret') }, 'https://managi.example/ws'),
      env('ops:s3cret'),
    );
    expect(outcome.setCookie).toContain('; Secure');
  });

  it('http 下不带 Secure（本地 wrangler dev 会被浏览器丢掉这枚 Cookie）', async () => {
    const outcome = await checkAuth(
      req({ Authorization: basic('ops', 's3cret') }, 'http://127.0.0.1:8787/'),
      env('ops:s3cret'),
    );
    expect(outcome.setCookie).not.toContain('Secure');
  });

  it('Cookie 的名字是固定且唯一的', async () => {
    const outcome = await checkAuth(req({ Authorization: basic('ops', 's3cret') }), env('ops:s3cret'));
    expect(outcome.setCookie!.startsWith('managi_auth=')).toBe(true);
  });
});

describe('unauthorizedResponse', () => {
  it('401 + Basic 挑战 + 不缓存', async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="managi", charset="UTF-8"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    await expect(response.json()).resolves.toEqual({ error: '需要访问口令' });
  });
});
