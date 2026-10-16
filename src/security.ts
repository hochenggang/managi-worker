// 目标地址护栏：只允许连公网地址，且把「校验过的 IP」直接拿去建连。
//
// 取自 EdgeSSH（逐字保留判定表）。两件事必须一起做才有意义：
//   1. 建连前解析 DNS 并逐个拒绝内网/保留段（否则 Worker 能被当成扫内网的跳板）；
//   2. 建连时用解析出来的 IP，而不是原始域名（否则解析与建连之间会被重绑定）。

function isIPv4(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
    && host.split('.').every((part) => Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
}

function normalizeIPv6(host: string): string {
  try {
    return new URL(`http://[${host}]`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}

export function isPrivateAddress(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value === '0.0.0.0'
    || value === 'metadata.google.internal' || value.endsWith('.internal')) return true;
  if (isIPv4(value)) {
    const [a, b, c] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (!value.includes(':')) return false;
  const ipv6 = normalizeIPv6(value);
  if (ipv6 === '::' || ipv6 === '::1'
    || /^f[cd]/.test(ipv6)
    || /^fe[89ab]/.test(ipv6)
    || ipv6.startsWith('2001:db8:')
    || ipv6.startsWith('ff')) return true;
  if (ipv6.startsWith('::ffff:')) {
    const mapped = ipv6.slice('::ffff:'.length);
    if (isIPv4(mapped)) return isPrivateAddress(mapped);
    const halves = mapped.split(':');
    if (halves.length === 2 && halves.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const numeric = (Number.parseInt(halves[0], 16) * 0x10000 + Number.parseInt(halves[1], 16)) >>> 0;
      return isPrivateAddress(`${numeric >>> 24}.${numeric >>> 16 & 0xff}.${numeric >>> 8 & 0xff}.${numeric & 0xff}`);
    }
    return true;
  }
  return false;
}

// cloudflare:sockets 的 connect() 把 hostname 与 port 拼成一个 "host:port"，
// 所以 IPv6 字面量必须带方括号（RFC 3986），否则出口代理解析不了。
export function toSocketHostname(address: string): string {
  if (address.includes(':') && !address.startsWith('[')) return `[${address}]`;
  return address;
}

interface DnsAnswer { type: number; data: string }

async function resolveDnsType(host: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const endpoint = 'https://cloudflare-dns.com/dns-query';
  const response = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, {
    headers: { Accept: 'application/dns-json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('无法解析目标域名');
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== 'https://cloudflare-dns.com'
    || !responseUrl.pathname.startsWith('/dns-query')
    || !response.headers.get('Content-Type')?.toLowerCase().startsWith('application/dns-json')) {
    throw new Error('DNS 解析返回了非预期响应');
  }
  const result = await response.json<{ Status: number; Answer?: DnsAnswer[] }>();
  if (result.Status !== 0 && result.Status !== 3) throw new Error('无法解析目标域名');
  if ((result.Answer?.length ?? 0) > 64) throw new Error('目标域名的 DNS 记录过多');
  const addresses: string[] = [];
  for (const answer of result.Answer ?? []) {
    if (answer.type === 1 && isIPv4(answer.data)) addresses.push(answer.data);
    if (answer.type === 28 && answer.data.includes(':')) {
      const normalized = normalizeIPv6(answer.data);
      if (!normalized.includes('%') && normalized.includes(':')) addresses.push(normalized);
    }
  }
  return addresses;
}

/** resolvePublicAddresses 解析域名；字面量 IP 原样返回。 */
export async function resolvePublicAddresses(host: string): Promise<string[]> {
  if (host.includes(':') || isIPv4(host)) return [host];
  const results = await Promise.allSettled([
    resolveDnsType(host, 'A'),
    resolveDnsType(host, 'AAAA'),
  ]);
  const addresses: string[] = [];
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    addresses.push(...result.value);
  }
  return addresses;
}

/** assertPublicTarget 校验目标并返回可建连的 IP 列表。 */
export async function assertPublicTarget(host: string): Promise<string[]> {
  if (isPrivateAddress(host)) throw new Error('已禁用私网/保留地址作为 SSH 目标');
  const addresses = await resolvePublicAddresses(host);
  if (addresses.length === 0) throw new Error('SSH 目标没有解析到任何地址');
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error('目标域名解析到了私网/保留地址');
  }
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  if (unique.length > 16) throw new Error('SSH 目标解析到过多地址');
  return unique;
}
