// 已知主机密钥（TOFU）。等价于 Go 版的 ~/.managi/known_hosts，只是换成 KV 落盘。
//
// 语义：某个 host:port 第一次连接时记下指纹；之后每次都必须一致，不一致就拒绝建连。
// 这是 Worker 版唯一挡住「中间人」的机制——凭据是逐请求带过来的，一旦连到假服务器
// 就等于把密码交出去。所以要改信任关系必须显式删掉 KV 里的对应键（见 README）。
//
// 没有绑定 KV（本地 wrangler dev 常见）时退化为「不校验」，只告警一次，不阻断使用。
//
// KVNamespace 用全局声明（与 types.ts 的 Env 一致）而不是从 '@cloudflare/workers-types'
// 具名导入：v5 起包内全局声明与具名导出是两套结构上不兼容的同名类型，混用会编译不过。

import { messageOf } from './util';

const PREFIX = 'hostkey:';

/**
 * 单 isolate 内的记忆：同一次连接里 host key 只查一次，重连频繁时能省掉往返。
 *
 * 必须带过期时间。README 教用户「删掉 KV 键即可重新信任换过密钥的服务器」，
 * 而 isolate 可能活很久 —— 没有 TTL 的话，删完键回到页面依旧被拒，
 * 用户只能看着一个已经删掉的记录发懵。60 秒足够省掉同一波重连的往返。
 */
const MEMO_TTL_MS = 60_000;
const memo = new Map<string, { fingerprint: string; at: number }>();

function memoGet(key: string): string | null {
  const entry = memo.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > MEMO_TTL_MS) {
    memo.delete(key);
    return null;
  }
  return entry.fingerprint;
}

export type HostKeyMode = 'tofu' | 'off';

export function hostKeyMode(value: string | undefined): HostKeyMode {
  return value === 'off' ? 'off' : 'tofu';
}

function keyOf(host: string, port: number): string {
  return `${PREFIX}${host.toLowerCase()}:${port}`;
}

export interface HostKeyResult {
  ok: boolean;
  /** 本次是新记录（true）还是命中已有记录（false）；不校验时为 false。 */
  recorded: boolean;
  reason?: string;
}

/**
 * verifyHostKey 校验主机密钥指纹。
 * 返回 ok=false 时调用方必须断开，并把 reason 报给用户。
 */
export async function verifyHostKey(
  kv: KVNamespace | undefined,
  mode: HostKeyMode,
  host: string,
  port: number,
  fingerprint: string,
): Promise<HostKeyResult> {
  if (mode === 'off') return { ok: true, recorded: false };
  if (!kv) {
    console.warn('[managi] 未绑定 MANAGI_KNOWN_HOSTS，已跳过主机密钥校验');
    return { ok: true, recorded: false };
  }
  const key = keyOf(host, port);
  const cached = memoGet(key);
  if (cached !== null) {
    return cached === fingerprint
      ? { ok: true, recorded: false }
      : { ok: false, recorded: false, reason: mismatchMessage(host, port, cached, fingerprint) };
  }
  let stored: string | null = null;
  try {
    stored = await kv.get(key);
  } catch (error) {
    // KV 读失败不该让用户连不上机器：放行并告警，下次再试。
    console.warn('[managi] 读取已知主机密钥失败：', messageOf(error));
    return { ok: true, recorded: false };
  }
  if (stored === null) {
    try {
      await kv.put(key, fingerprint);
    } catch (error) {
      console.warn('[managi] 记录主机密钥失败：', messageOf(error));
      return { ok: true, recorded: true };
    }
    memo.set(key, { fingerprint, at: Date.now() });
    return { ok: true, recorded: true };
  }
  memo.set(key, { fingerprint: stored, at: Date.now() });
  return stored === fingerprint
    ? { ok: true, recorded: false }
    : { ok: false, recorded: false, reason: mismatchMessage(host, port, stored, fingerprint) };
}

function mismatchMessage(host: string, port: number, stored: string, actual: string): string {
  return `主机密钥与记录不一致：${host}:${port}\n已记录 ${stored}\n本次收到 ${actual}\n`
    + '如果服务器确实换过密钥，请在 Cloudflare 控制台删除 KV 键 '
    + `${keyOf(host, port)} 后重试。`;
}
