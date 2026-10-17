// 建连：把「节点描述」变成一条**已通过公网校验、已挂上主机密钥校验**的 SSH 连接。
//
// 唯一的入口是 WS 的 open：校验目标 → 建 TCP → 造连接。
// 规则只写一遍，才不会出现「某个路径漏了 SSRF 校验」这种要命的分叉。
//
// 这里是**全工程唯一**接触 `cloudflare:sockets` 的地方：
//   · Worker 出站 TCP 只能连公网，且必须用「校验过的 IP」而不是原始域名（防 DNS 重绑定）。

import { connect } from 'cloudflare:sockets';
import { SSHConnection, type ConnectionHooks } from './session';
import { buildNodeConfig } from './node';
import { assertPublicTarget, toSocketHostname } from './security';
import { hostKeyMode, verifyHostKey } from './host-keys';
import type { ApiNode } from './protocol';
import type { Env } from './types';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MIN_CONNECT_TIMEOUT_MS = 2_000;
const MAX_CONNECT_TIMEOUT_MS = 30_000;

/** connectTimeoutMs 读 CONNECT_TIMEOUT_MS 并钳到 2s ~ 30s，坏值回退默认。 */
export function connectTimeoutMs(value: string | undefined): number {
  // 空串要单独挡：Number('') 是 0，会被钳成 2 秒 —— 而「没配」显然不是「配成 0」。
  const raw = value?.trim() ?? '';
  if (raw === '') return DEFAULT_CONNECT_TIMEOUT_MS;
  const configured = Number(raw);
  if (!Number.isFinite(configured)) return DEFAULT_CONNECT_TIMEOUT_MS;
  return Math.min(MAX_CONNECT_TIMEOUT_MS, Math.max(MIN_CONNECT_TIMEOUT_MS, Math.floor(configured)));
}

/**
 * openVerifiedSocket 逐个试「校验通过的 IP」，返回第一个连上的 socket。
 * 传进来的一定是 IP 字面量，所以此处不存在第二次解析 —— 重绑定的窗口被彻底关掉。
 */
export async function openVerifiedSocket(
  addresses: string[],
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  let lastError: unknown = new Error('没有可用的目标地址');
  for (const address of addresses) {
    const socket = connect(
      { hostname: toSocketHostname(address), port },
      { secureTransport: 'off', allowHalfOpen: false },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        socket.opened,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TCP 连接超时')), timeoutMs);
        }),
      ]);
      return socket;
    } catch (error) {
      lastError = error;
      try { void socket.close().catch(() => undefined); } catch { /* 已关闭 */ }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError;
}

export interface DialOptions {
  /** PTY 初始尺寸。sftp 不关心，省略即用默认。 */
  cols?: unknown;
  rows?: unknown;
  /** 连接彻底结束的通知；不需要额外动作时传空函数即可。 */
  onEnded: (error: Error) => void;
}

/**
 * dialNode 建好一条 SSH 连接（**尚未握手**，握手由调用方按自己的超时预算触发）。
 * 抛错时还没建立的资源会在这里收干净，但 TCP socket 已经交给了 SSHConnection。
 */
export async function dialNode(env: Env, node: ApiNode, options: DialOptions): Promise<SSHConnection> {
  const host = node.host.trim();
  const addresses = await assertPublicTarget(host);
  const socket = await openVerifiedSocket(addresses, node.port, connectTimeoutMs(env.CONNECT_TIMEOUT_MS));
  const mode = hostKeyMode(env.HOST_KEY_MODE);
  const hooks: ConnectionHooks = {
    ended: options.onEnded,
    // KV 键按「小写主机名:端口」归一，避免 example.com 与 Example.com 各记一条。
    verifyHostKey: (fingerprint) => verifyHostKey(env.MANAGI_KNOWN_HOSTS, mode, host, node.port, fingerprint),
  };
  return new SSHConnection(socket, buildNodeConfig(node, options.cols, options.rows), hooks);
}
