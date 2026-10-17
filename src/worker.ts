// Worker 入口：访问口令 + WebSocket 入口 + 静态资源兜底。
//
//   GET  /ws           → WebSocket 升级，转给 Durable Object（按 client_id 定位）
//   GET  /api/version  → 报出当前部署的版本信息（判断线上跑的是哪一版）
//   其余               → 交给 [assets] 绑定的静态资源（单文件 SPA）
//
// HTTP 上只有这两条：终端、文件收发全部走 /ws 一条连接。
// 这里不再有 POST /api/* —— 没有「服务端替你连一批机器」这种请求，
// 连接的生命周期就永远绑在一条 WebSocket 上，断开即释放。

import { messageOf } from './util';
import { checkAuth, unauthorizedResponse } from './auth';
import type { Env } from './types';

export { ManagiSessionDO } from './durable-object';

function jsonError(message: string, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

// ===== 入口 =====

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const auth = await checkAuth(request, env);
      if (!auth.ok) return unauthorizedResponse();
      // /ws 只走升级：101 响应不能被重新包一层（会丢掉 webSocket 句柄），
      // 而它本身也不需要 Cookie —— 握手用的一定是已经下发过的那枚。
      if (url.pathname === '/ws') return await handleWs(request, env);

      // 版本探针：线上到底跑的是哪一版，只看这一个 GET 就知道。
      // 没有它，「改了没生效」和「代码还是坏的」这两种情况从外部无法区分。
      if (url.pathname === '/api/version') {
        const version = versionResponse(env);
        return auth.setCookie ? withCookie(version, auth.setCookie) : version;
      }

      // 已删除的接口要说明白，别让旧前端对着 404 猜。
      if (url.pathname.startsWith('/api/')) {
        return jsonError(`unknown api path: ${request.method} ${url.pathname}`, 404);
      }

      if (!env.ASSETS) return jsonError('静态资源绑定缺失（[assets] 未配置）', 503);
      const response = await env.ASSETS.fetch(request);
      return auth.setCookie ? withCookie(response, auth.setCookie) : response;
    } catch (error) {
      return jsonError(messageOf(error), 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** withCookie 把会话 Cookie 挂到响应上，正文与状态原样透传。 */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * versionResponse 报出这个 isolate 的部署身份。
 * 值来自 wrangler 的 [[version_metadata]] 绑定：不依赖任何人记得改常量，
 * 也不会因为「部署了旧提交」而谎报——它说的就是跑起来的这一份。
 */
function versionResponse(env: Env): Response {
  const meta = env.CF_VERSION_METADATA;
  return new Response(JSON.stringify({
    worker: 'managi-worker',
    deploy: meta ? { id: meta.id, tag: meta.tag, timestamp: meta.timestamp } : null,
  }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * handleWs 升级 WebSocket，并把它拴到一个 DO 实例上。
 *
 * DO 的身份由浏览器给的 client_id 决定，而不是每次 newUniqueId()：
 * 一条 WS 断了之后前端会用同一个 client_id 重连，必须落回**同一个** DO，
 * 才可能接回还在跑的 shell（见 sessions.ts）。缺 client_id 时退化成一次性实例——
 * 功能照常，只是断线后会话不保。
 *
 * client_id 由前端生成、存在 sessionStorage（每个标签一个），不是凭据：
 * 它只决定「落到哪个 DO」，授权仍然由口令闸负责。
 */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function handleWs(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return jsonError('method not allowed: use GET', 405, { Allow: 'GET' });
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return jsonError('WebSocket upgrade required', 426);
  }
  // 拦 CSWSH：别的站点只要 new WebSocket() 就能借我们已缓存的 Basic 凭据开终端。
  // 没带 Origin 的是非浏览器客户端（curl / 脚本），放行。
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return jsonError('WebSocket origin is not allowed', 403);
  }
  const headers = new Headers(request.headers);
  // 口令与 Cookie 到此为止：DO 不需要知道它们，也就不该有机会泄漏。
  headers.delete('Authorization');
  headers.delete('Cookie');
  const clientId = new URL(request.url).searchParams.get('client');
  const sessions = env.MANAGI_SESSIONS;
  const id = clientId && CLIENT_ID_RE.test(clientId)
    ? sessions.idFromName(`client:${clientId}`)
    : sessions.newUniqueId();
  return await sessions.get(id).fetch(new Request('https://session.internal/connect', { headers }));
}
