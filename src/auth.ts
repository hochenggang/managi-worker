// 访问口令：HTTP Basic Auth + 一枚自签名会话 Cookie。
//
// 为什么不只用 Basic Auth：浏览器不允许页面给 WebSocket 握手加自定义头，
// 能不能自动带上已缓存的 Basic 凭据完全看浏览器实现（部分 WebView / Safari
// 不带给 WebSocket 通道）。一旦带不上，/ws 就永远 401，页面看着正常却一个终端都开不出来。
// 所以页面首次通过 Basic 认证时顺手发一枚 HttpOnly 的签名 Cookie ——
// 同源 WebSocket 握手一定会带 Cookie，这条路不依赖浏览器心情。
//
// Cookie 没有服务端状态：值就是 `过期时间戳.HMAC(时间戳)`，密钥由 MANAGI_AUTH 派生。
// 改口令即等于作废所有已发 Cookie，无需任何撤销表。

import type { Env } from './types';

const COOKIE_NAME = 'managi_auth';
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** MANAGI_AUTH 缺冒号时用户名回退值（与 Go 的 DefaultBasicAuthUser 一致）。 */
const DEFAULT_AUTH_USER = 'admin';

const encoder = new TextEncoder();

/** 派生密钥按口令缓存：同一 isolate 内每个请求都 importKey 是白扔 CPU。 */
const keyCache = new Map<string, Promise<CryptoKey>>();

export interface AuthOutcome {
  ok: boolean;
  /** 需要下发的会话 Cookie（仅在本请求靠 Basic 凭据通过时给出）。 */
  setCookie?: string;
  /** 失败类别：unconfigured 表示根本没配口令，重试多少次都没用。 */
  failure?: 'unconfigured';
}

/** parseBasicAuth 解析 `user:pass`；空值返回 null（= 不启用鉴权）。 */
function parseBasicAuth(value: string | undefined): { user: string; pass: string } | null {
  if (value === undefined || value === '') return null;
  const index = value.indexOf(':');
  // 缺冒号时整串当密码，用户名回退——与 Go 版同样「出声提醒写法」
  if (index < 0) return { user: DEFAULT_AUTH_USER, pass: value };
  return { user: value.slice(0, index) || DEFAULT_AUTH_USER, pass: value.slice(index + 1) };
}

/** bytesEqual 长度无关的逐字节比较：口令比较不该泄漏「第几位开始不同」。 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** decodeBase64 解标准 base64（Basic 凭据用，带填充）。 */
function decodeBase64(value: string): Uint8Array | null {
  try {
    return binaryToBytes(atob(value));
  } catch {
    return null;
  }
}

/** decodeBase64Url 解 URL 安全 base64（Cookie 用，无填充）。 */
function decodeBase64Url(value: string): Uint8Array | null {
  try {
    return binaryToBytes(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, cached);
  }
  return cached;
}

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

let warnedMissingSecret = false;

/** 显式开放的标记值：写这些就是「我知道这条是无口令的」。 */
const PUBLIC_MARKERS = new Set(['off', 'none']);

/**
 * checkAuth 判定这个请求是否通过。
 *
 * **默认拒绝**：MANAGI_AUTH 没配就不提供服务。
 * 以前这里是 fail-open（放行 + 告警一次），代价太不对称——忘配一次，
 * 这台 Worker 就成了任何人借来连你机器的跳板，而告警只在日志里闪过一行。
 * 真想公开访问，把它设成 `off`（或 `none`），那是需要主动敲下来的决定。
 */
export async function checkAuth(request: Request, env: Env): Promise<AuthOutcome> {
  // 比对用原值：口令里的空格也是口令的一部分，不能被 trim 掉。
  const secret = env.MANAGI_AUTH ?? '';
  const marker = secret.trim().toLowerCase();
  if (PUBLIC_MARKERS.has(marker)) return { ok: true };
  if (marker === '') {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.error('[managi] 未配置 MANAGI_AUTH，已拒绝全部请求。'
        + '请把它设为 `用户名:密码`；确需公开访问再设成 off。');
    }
    return { ok: false, failure: 'unconfigured' };
  }
  if (await matchesBasic(request.headers.get('Authorization'), secret)) {
    return { ok: true, setCookie: await issueCookie(request, secret) };
  }
  if (await matchesCookie(request.headers.get('Cookie'), secret)) return { ok: true };
  return { ok: false };
}

async function matchesBasic(header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  const expected = parseBasicAuth(secret);
  if (!expected) return false;
  const presented = decodeBase64(match[1]!);
  // 浏览器默认按 UTF-8 编码凭据，故与 UTF-8 字节比对（口令里有中文也对得上）
  if (!presented) return false;
  return bytesEqual(presented, encoder.encode(`${expected.user}:${expected.pass}`));
}

async function matchesCookie(header: string | null, secret: string): Promise<boolean> {
  const raw = readCookie(header, COOKIE_NAME);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot);
  const expiresAt = Number(payload);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  const presented = decodeBase64Url(raw.slice(dot + 1));
  if (!presented) return false;
  return bytesEqual(presented, await sign(secret, payload));
}

async function issueCookie(request: Request, secret: string): Promise<string> {
  const expiresAt = Date.now() + COOKIE_TTL_MS;
  const token = `${expiresAt}.${base64Url(await sign(secret, String(expiresAt)))}`;
  // 本地 wrangler dev 是 http://localhost，带 Secure 的 Cookie 会被浏览器丢掉
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}`
    + `; HttpOnly; SameSite=Strict${secure}`;
}

/**
 * unauthorizedResponse 未通过鉴权时的响应。
 * 配了口令 → 401 + Basic 挑战（浏览器据此弹出账号密码框）。
 * 没配口令 → 503 + 明确指引：这时候给 401 只会让人反复试密码。
 */
export function unauthorizedResponse(outcome?: AuthOutcome): Response {
  if (outcome?.failure === 'unconfigured') {
    return new Response(JSON.stringify({
      error: '未配置访问口令（MANAGI_AUTH），服务已拒绝请求',
      hint: '请把 MANAGI_AUTH 设为 `用户名:密码`；确认要公开访问时设为 off。',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(JSON.stringify({ error: '需要访问口令' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="managi", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}
