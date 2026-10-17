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

/**
 * 未配置 MANAGI_AUTH 时用的口令。
 *
 * 曾经这里是「默认拒绝」（503 + 提示）。纸面上更安全，实际代价是**第一次部署必定报错**：
 * 新手看到 503 只会以为装坏了，而不会想到「少设了一个变量」。
 * 所以默认为 admin:admin —— 部署完就能进，登录框填 admin / admin。
 * 这也是一个众所周知的口令，日志与 README 都会提醒尽快改掉。
 */
const DEFAULT_AUTH = 'admin:admin';

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

let warnedDefaultSecret = false;

/** 显式开放的标记值：写这些就是「我知道这条是无口令的」。 */
const PUBLIC_MARKERS = new Set(['off', 'none']);

/** 用默认口令时在日志里说一声。只一次，否则每个请求刷一行。 */
function warnDefaultSecret(): void {
  if (warnedDefaultSecret) return;
  warnedDefaultSecret = true;
  console.warn('[managi] 未配置 MANAGI_AUTH，正在使用默认口令 admin:admin。'
    + '任何知道这个口令的人都能操作你的机器，请尽快改成自己的 `用户名:密码`。');
}

/**
 * checkAuth 判定这个请求是否通过。
 *
 * **默认口令**：MANAGI_AUTH 没配（或设成空串）时回落到 admin:admin，
 * 部署完就能进，不必先去控制台配一个变量。代价是这个口令是公开的 ——
 * 日志与 README 都会提醒尽快改掉。
 * 真想公开访问，把它设成 `off`（或 `none`），那是需要主动敲下来的决定。
 */
export async function checkAuth(request: Request, env: Env): Promise<AuthOutcome> {
  // 比对用原值：口令里的空格也是口令的一部分，不能被 trim 掉。
  const raw = env.MANAGI_AUTH ?? '';
  if (PUBLIC_MARKERS.has(raw.trim().toLowerCase())) return { ok: true };
  const secret = raw.trim() === '' ? DEFAULT_AUTH : raw;
  if (secret === DEFAULT_AUTH) warnDefaultSecret();
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
 * unauthorizedResponse 未通过鉴权时的响应：401 + Basic 挑战，
 * 浏览器据此弹出账号密码框。没配口令时也有默认值兜着，不会再出现
 * 「服务端没配置」这种前端无从修复的 503。
 */
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
