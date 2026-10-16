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

/** checkAuth 判定这个请求是否通过；MANAGI_AUTH 为空即不鉴权（只告警一次）。 */
export async function checkAuth(request: Request, env: Env): Promise<AuthOutcome> {
  const secret = env.MANAGI_AUTH ?? '';
  if (secret === '') {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn('[managi] 未设置 MANAGI_AUTH：任何人都能访问这个 Worker，并借它去连你的机器');
    }
    return { ok: true };
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

/** unauthorizedResponse 401 + Basic 挑战，浏览器据此弹出账号密码框。 */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: '需要访问口令' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="managi", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}
