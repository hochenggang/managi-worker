// Worker 入口：访问口令 + 三条入口 + 静态资源兜底。
//
//   GET  /ws                  → WebSocket 升级，转给一个全新的 Durable Object
//   POST /api/ssh/batch       → 多节点并发跑一段脚本，收 stdout/stderr/退出码
//   POST /api/sftp/download   → SFTP 读远端文件，按 HTTP Range 边读边回
//   其余                      → 交给 [assets] 绑定的静态资源（单文件 SPA）
//
// 前端一行没改：它按同源推导 /ws 与两个 /api 前缀，凭据始终放在请求体里。
// 这里的角色就是中转：过路看一眼，不落盘、不缓存。

import type { ApiNode, CmdsTestResult } from './protocol';
import {
  ExecHandler,
  SFTPHandler,
  SSHConnection,
  describeConnectFailure,
  type ChannelCallbacks,
  type ExecResult,
} from './session';
import { dialNode } from './dial';
import { maskNode, validateNode } from './node';
import { HttpError, deferred, messageOf, splitLines, toError, withTimeout } from './util';
import { checkAuth, unauthorizedResponse } from './auth';
import type { Env } from './types';

export { ManagiSessionDO } from './durable-object';

const encoder = new TextEncoder();

// ===== 与 Go 版对齐的硬闸 =====

/** 单次批量请求允许的节点数上限（Go: maxBatchNodes）。 */
const MAX_BATCH_NODES = 100;
/** 并发拨号上限：再多就是把 Cloudflare 的并发预算全花在等待远端握手。 */
const BATCH_CONCURRENCY = 10;
/** 单节点命令执行总时限（Go: batchExecTimeout）。到点关连接终止远端命令。 */
const EXEC_TIMEOUT_MS = 15 * 60_000;
/** stdout/stderr 各自收集上限（Go: MaxExecOutputBytes）。 */
const MAX_EXEC_OUTPUT_BYTES = 4 << 20;
/** TCP + 密钥协商 + 认证的总预算。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** 请求体上限（Go: maxRequestBodySize）。 */
const MAX_BODY_BYTES = 10 << 20;

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

      let response: Response;
      if (url.pathname.startsWith('/api/')) {
        response = await handleApi(request, env, url.pathname);
      } else {
        if (!env.ASSETS) return jsonError('静态资源绑定缺失（[assets] 未配置）', 503);
        response = await env.ASSETS.fetch(request);
      }
      return auth.setCookie ? withCookie(response, auth.setCookie) : response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return jsonError(messageOf(error), status);
    }
  },
} satisfies ExportedHandler<Env>;

/** withCookie 把会话 Cookie 挂到响应上，正文与状态原样透传。 */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** handleWs 升级 WebSocket，并把它拴到一个全新的 DO 实例上（一条连接 = 一个 DO）。 */
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
  const stub = env.MANAGI_SESSIONS.get(env.MANAGI_SESSIONS.newUniqueId());
  return await stub.fetch(new Request('https://session.internal/connect', { headers }));
}

async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError('method not allowed: use POST', 405, { Allow: 'POST' });
  }
  // CSRF 闸：浏览器会自动把 Basic Auth 带给同站/跨站请求，所以写操作必须看出身。
  // 空值是非浏览器客户端（curl 等），放行——与 Go 版 apiPost 同款判断。
  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return jsonError('cross-site request rejected', 403);
  }
  if (pathname === '/api/ssh/batch') return await handleBatch(request, env);
  if (pathname === '/api/sftp/download') return await handleDownload(request, env);
  return jsonError(`unknown api path: POST ${pathname}`, 404);
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  // 先看 Content-Length：声明就超标的请求体不该先读进内存再判。
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, '请求体过大');
  const text = await request.text();
  if (encoder.encode(text).length > maxBytes) throw new HttpError(413, '请求体过大');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

// ===== POST /api/ssh/batch =====

async function handleBatch(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonBody(request, MAX_BODY_BYTES)) as { nodes?: unknown; cmds?: unknown };
  const nodes = body?.nodes;
  const cmds = body?.cmds;
  if (!Array.isArray(nodes)) throw new HttpError(400, 'nodes 必须是数组');
  if (!Array.isArray(cmds) || cmds.some((cmd) => typeof cmd !== 'string')) {
    throw new HttpError(400, 'cmds 必须是字符串数组');
  }
  if (nodes.length > MAX_BATCH_NODES) {
    throw new HttpError(400, `节点数超过上限（最多 ${MAX_BATCH_NODES} 个）`);
  }
  // 多条命令在同一个 shell 里顺序执行——这正是前端 textarea 一行的含义。
  const command = (cmds as string[]).join('\n');
  const results = await mapWithLimit(nodes as ApiNode[], BATCH_CONCURRENCY, (node) =>
    runBatchNode(env, node, command));
  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** mapWithLimit 固定并发跑完一整批；单点失败不牵动其他点（失败由结果对象表达）。 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runBatchNode(env: Env, node: ApiNode, command: string): Promise<CmdsTestResult> {
  const started = Date.now();
  const masked = maskNode(node);
  const base: CmdsTestResult = {
    time_elapsed: 0,
    success: false,
    output: [],
    error: [],
    node: masked,
    cmds: command,
  };
  if (command === '') {
    // 与 Go 版一致：没有命令等于没什么可失败，回空成功。
    return { ...base, success: true };
  }

  let conn: SSHConnection | null = null;
  try {
    validateNode(node);
    conn = await dialNode(env, node, { cols: 80, rows: 24, onEnded: () => undefined });
    const connection = conn;
    await withTimeout(connection.handshake(), HANDSHAKE_TIMEOUT_MS, 'SSH 握手超时');

    let timedOut = false;
    const result = await runExec(connection, command, () => { timedOut = true; });
    if (timedOut) {
      return {
        ...base,
        time_elapsed: (Date.now() - started) / 1000,
        error: [`命令执行超时（上限 ${EXEC_TIMEOUT_MS / 60_000} 分钟），已终止`],
      };
    }
    const output = splitLines(result.stdout);
    // 截断提示放 output：它是展示限制而非命令失败，混进 error 会把 success 判成 false。
    if (result.stdoutTruncated) output.push(truncateNote('stdout'));
    if (result.stderrTruncated) output.push(truncateNote('stderr'));
    const errors = splitLines(result.stderr);
    return {
      ...base,
      time_elapsed: (Date.now() - started) / 1000,
      success: errors.length === 0,
      output,
      error: errors,
    };
  } catch (error) {
    return {
      ...base,
      time_elapsed: (Date.now() - started) / 1000,
      error: [describeConnectFailure(error, node.host, node.port)],
    };
  } finally {
    try { conn?.close(); } catch { /* 已关闭 */ }
  }
}

/** runExec 跑一条非交互命令，收集到通道关闭（或到点被关）为止。 */
function runExec(
  connection: SSHConnection,
  command: string,
  onTimeout: () => void,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const handler = new ExecHandler(connection, command, MAX_EXEC_OUTPUT_BYTES, settle);
    timer = setTimeout(() => {
      onTimeout();
      // 关连接会让通道走 onClose → finish() → settle；通道还没建起来时由下一行兜底。
      connection.close();
      settle({ stdout: '', stderr: '', exitStatus: null });
    }, EXEC_TIMEOUT_MS);
    try {
      connection.openExec(handler);
    } catch (error) {
      if (timer) clearTimeout(timer);
      settled = true;
      reject(toError(error));
    }
  });
}

function truncateNote(stream: string): string {
  return `[managi] ${stream} 输出超过 ${MAX_EXEC_OUTPUT_BYTES >> 20}MB，已截断`;
}

// ===== POST /api/sftp/download =====

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonBody(request, MAX_BODY_BYTES)) as { node?: ApiNode; path?: unknown };
  const node = body?.node;
  const path = body?.path;
  if (typeof path !== 'string' || path === '') throw new HttpError(400, 'missing node or path');
  try {
    validateNode(node);
  } catch (error) {
    throw new HttpError(400, messageOf(error));
  }
  const target = node!;

  let conn: SSHConnection | null = null;
  try {
    conn = await dialNode(env, target, { cols: 80, rows: 24, onEnded: () => undefined });
    const connection = conn;

    // 流的收尾只做一次：SFTP 侧结束时 cb.data(_, true)，连接关闭又会让
    // SFTPHandler.onClose 再补一发，重复 close() 一个已关的流会抛异常。
    let streamDone = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const closeStream = (): void => {
      if (streamDone) return;
      streamDone = true;
      try { controller?.close(); } catch { /* 已关闭 */ }
    };
    const failStream = (message: string): void => {
      if (streamDone) return;
      streamDone = true;
      try { controller?.error(new Error(message)); } catch { /* 已关闭 */ }
    };

    const opened = deferred<string>();
    const callbacks: ChannelCallbacks = {
      data: (payload, end) => {
        if (!streamDone && payload.byteLength > 0) {
          try { controller?.enqueue(payload); } catch { /* 消费端已取消 */ }
        }
        if (end) {
          closeStream();
          connection.close();
        }
      },
      control: () => undefined, // 下载是 HTTP 流，没有 ack 这类控制帧要转
      error: (message) => { failStream(message); connection.close(); },
      ready: (info) => opened.resolve(info ?? ''),
      failed: (message) => opened.reject(new Error(message)),
    };

    await withTimeout(connection.handshake(), HANDSHAKE_TIMEOUT_MS, 'SSH 握手超时');
    const handler = new SFTPHandler(connection, callbacks);
    connection.openSFTP(handler);
    await withTimeout(opened.promise, HANDSHAKE_TIMEOUT_MS, 'SFTP 子系统握手超时');

    const rangeRequested = request.headers.get('Range') !== null;
    const offset = parseRangeStart(request.headers.get('Range'));
    const download = await handler.download(path, offset);
    const total = download.total;

    const stream = new ReadableStream<Uint8Array>({
      start: (c) => { controller = c; },
      cancel: () => { try { connection.close(); } catch { /* 已关闭 */ } },
    });

    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      // 续传的响应体就是「从 offset 到文件尾」，长度按剩下的算
      'Content-Length': String(Math.max(total - offset, 0)),
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${offset}-${Math.max(total - 1, 0)}/${total}`,
      'Content-Disposition': contentDisposition(download.filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    // 响应头备好之后再开跑，字节才会落在这条响应上。
    download.start();
    return new Response(stream, { status: rangeRequested ? 206 : 200, headers });
  } catch (error) {
    try { conn?.close(); } catch { /* 已关闭 */ }
    return jsonError(messageOf(error), 502);
  }
}

/** parseRangeStart 解析 `bytes=N-`。不支持的形式（多段、后缀区间）退回整份。 */
function parseRangeStart(header: string | null): number {
  if (!header) return 0;
  const match = /^\s*bytes\s*=\s*(\d+)\s*-/.exec(header);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function contentDisposition(filename: string): string {
  // 文件名可能含中文：给一份 ASCII 兜底，再按 RFC 5987 附上真名。
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
