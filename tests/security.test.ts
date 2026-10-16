import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublicTarget,
  isPrivateAddress,
  resolvePublicAddresses,
  toSocketHostname,
} from '../src/security';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isPrivateAddress —— IPv4', () => {
  const blocked = [
    ['0.0.0.0', '本网络'],
    ['0.1.2.3', '整个 0/8'],
    ['10.0.0.1', 'A 类私网'],
    ['10.255.255.255', 'A 类私网边界'],
    ['127.0.0.1', '回环'],
    ['127.255.255.254', '回环边界'],
    ['100.64.0.1', 'CGNAT 起点'],
    ['100.127.255.255', 'CGNAT 终点'],
    ['169.254.1.1', '链路本地（云元数据服务的常用落点）'],
    ['172.16.0.1', 'B 类私网起点'],
    ['172.31.255.255', 'B 类私网终点'],
    ['192.0.0.1', 'IETF 保留'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 中继'],
    ['192.168.1.1', 'C 类私网'],
    ['198.18.0.1', 'benchmark 起点'],
    ['198.19.255.255', 'benchmark 终点'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', '组播'],
    ['239.255.255.255', '组播边界'],
    ['255.255.255.255', '广播'],
  ];

  it.each(blocked)('%s 被拒（%s）', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  const allowed = [
    ['1.1.1.1', '公共 DNS'],
    ['8.8.8.8', '公共 DNS'],
    ['11.0.0.1', '紧挨私网但属于公网'],
    ['100.63.0.1', 'CGNAT 之前'],
    ['100.128.0.1', 'CGNAT 之后'],
    ['172.15.255.255', '紧邻 B 类私网下方'],
    ['172.32.0.1', '紧邻 B 类私网上方'],
    ['192.167.255.255', '紧邻 C 类私网下方'],
    ['192.169.0.1', '紧邻 C 类私网上方'],
    ['198.20.0.1', '紧邻 benchmark 上方'],
    ['203.0.114.1', '紧邻 TEST-NET-3 上方'],
    ['223.255.255.255', '组播之前最后一个单播'],
  ];

  it.each(allowed)('%s 放行（%s）', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('前导零的数字不会被当成 IPv4（避免解析歧义被绕开）', () => {
    // 010.0.0.1 在部分解析器里是八进制 = 8.0.0.1，干脆不认它是 IPv4。
    expect(isPrivateAddress('010.0.0.1')).toBe(false);
    expect(isPrivateAddress('127.0.0.01')).toBe(false);
  });
});

describe('isPrivateAddress —— 主机名与 IPv6', () => {
  it('特殊主机名被拒', () => {
    expect(isPrivateAddress('localhost')).toBe(true);
    expect(isPrivateAddress('LOCALHOST')).toBe(true);
    expect(isPrivateAddress('a.localhost')).toBe(true);
    expect(isPrivateAddress('metadata.google.internal')).toBe(true);
    expect(isPrivateAddress('anything.internal')).toBe(true);
  });

  it('普通域名放行（是否解析到私网由 assertPublicTarget 再查）', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('github.com')).toBe(false);
  });

  it('IPv6 特殊段被拒', () => {
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fd12:3456::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fe90::1')).toBe(true);
    expect(isPrivateAddress('feb0::1')).toBe(true);
    expect(isPrivateAddress('ff02::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(true);
  });

  it('IPv6 写在外层还有方括号时也能判（浏览器的 URL 常量可能带括号）', () => {
    expect(isPrivateAddress('[::1]')).toBe(true);
    expect(isPrivateAddress('[fe80::1]')).toBe(true);
  });

  it('IPv4 映射的 IPv6 会追到底下的 IPv4 再判', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false);
  });

  it('映射段解不出 IPv4 时按最保守处理（当作私有拒掉，而不是放行）', () => {
    // ::ffff: 后面既不是点分十进制、也不是两段十六进制 —— 解析不了就不赌它是公网。
    expect(isPrivateAddress('::ffff:nonsense')).toBe(true);
    expect(isPrivateAddress('::ffff:1:2:3')).toBe(true);
  });

  it('公网 IPv6 放行', () => {
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('压平后的 IPv6 也能判（未压缩写法必须先规范化）', () => {
    expect(isPrivateAddress('fe80:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isPrivateAddress('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
  });
});

describe('toSocketHostname', () => {
  it('IPv6 字面量补方括号（connect() 会把 host:port 拼起来，不括起来解析不了）', () => {
    expect(toSocketHostname('2606:4700::1111')).toBe('[2606:4700::1111]');
    expect(toSocketHostname('::1')).toBe('[::1]');
  });

  it('已经有方括号的不重复加', () => {
    expect(toSocketHostname('[2606:4700::1111]')).toBe('[2606:4700::1111]');
  });

  it('IPv4 与域名原样返回', () => {
    expect(toSocketHostname('1.2.3.4')).toBe('1.2.3.4');
    expect(toSocketHostname('example.com')).toBe('example.com');
  });
});

// ===== DNS 相关：把 fetch 换成可控的假 DoH 服务 =====

interface DnsAnswer {
  type: number;
  data: string;
}

interface DnsStubOptions {
  A?: string[];
  AAAA?: string[];
  status?: number;
  ok?: boolean;
  contentType?: string;
  url?: string;
}

/** stubDns 装一个可按查询类型返回不同记录、也可按需装错的 DoH 端点。 */
function stubDns(options: DnsStubOptions): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const type = new URL(String(input)).searchParams.get('type');
    const values = type === 'AAAA' ? (options.AAAA ?? []) : (options.A ?? []);
    const answer: DnsAnswer[] = values.map((data) => ({ type: type === 'AAAA' ? 28 : 1, data }));
    return {
      ok: options.ok ?? true,
      url: options.url ?? `https://cloudflare-dns.com/dns-query?name=x&type=${type}`,
      headers: new Headers({ 'Content-Type': options.contentType ?? 'application/dns-json' }),
      json: async () => ({ Status: options.status ?? 0, Answer: answer }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolvePublicAddresses', () => {
  it('字面量 IP 直接返回，不发 DNS 查询', async () => {
    const fetchMock = stubDns({});
    await expect(resolvePublicAddresses('1.2.3.4')).resolves.toEqual(['1.2.3.4']);
    await expect(resolvePublicAddresses('2606:4700::1111')).resolves.toEqual(['2606:4700::1111']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('域名同时查 A 与 AAAA，A 在前', async () => {
    stubDns({ A: ['93.184.216.34'], AAAA: ['2606:2800:220:1::1'] });
    await expect(resolvePublicAddresses('example.com')).resolves.toEqual([
      '93.184.216.34',
      '2606:2800:220:1::1',
    ]);
  });

  it('IPv6 记录会被规范化并小写', async () => {
    stubDns({ AAAA: ['2606:2800:0220:0001:0000:0000:0000:0001'] });
    await expect(resolvePublicAddresses('example.com')).resolves.toEqual(['2606:2800:220:1::1']);
  });

  it('忽略装成 A 记录塞进来的非 IPv4 内容，也忽略带 scope 的 IPv6', async () => {
    stubDns({ A: ['not-an-ip'], AAAA: ['fe80::1%eth0'] });
    await expect(resolvePublicAddresses('example.com')).resolves.toEqual([]);
  });

  it('NXDOMAIN（Status=3）视为没有记录，而不是报错', async () => {
    stubDns({ status: 3 });
    await expect(resolvePublicAddresses('nope.example')).resolves.toEqual([]);
  });

  it('SERVFAIL（Status=2）报错', async () => {
    stubDns({ status: 2 });
    await expect(resolvePublicAddresses('broken.example')).rejects.toThrow('无法解析目标域名');
  });

  it('HTTP 非 2xx 报错', async () => {
    stubDns({ ok: false });
    await expect(resolvePublicAddresses('broken.example')).rejects.toThrow('无法解析目标域名');
  });

  it('返回被重定向到别的域名时拒绝（防拿别人的响应冒充）', async () => {
    stubDns({ A: ['1.2.3.4'], url: 'https://evil.example/dns-query' });
    await expect(resolvePublicAddresses('example.com')).rejects.toThrow('非预期响应');
  });

  it('Content-Type 不是 application/dns-json 时拒绝', async () => {
    stubDns({ A: ['1.2.3.4'], contentType: 'text/html' });
    await expect(resolvePublicAddresses('example.com')).rejects.toThrow('非预期响应');
  });

  it('记录条数超过上限时拒绝（防用超大响应撑爆解析）', async () => {
    stubDns({ A: Array.from({ length: 65 }, (_, i) => `1.2.3.${i % 256}`) });
    await expect(resolvePublicAddresses('example.com')).rejects.toThrow('DNS 记录过多');
  });
});

describe('assertPublicTarget', () => {
  it('字面量公网 IP 直接通过，不需要 DNS', async () => {
    const fetchMock = stubDns({});
    await expect(assertPublicTarget('1.2.3.4')).resolves.toEqual(['1.2.3.4']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('字面量私网 IP 在建连之前就被拦下', async () => {
    await expect(assertPublicTarget('127.0.0.1')).rejects.toThrow('已禁用私网/保留地址');
    await expect(assertPublicTarget('10.0.0.5')).rejects.toThrow('已禁用私网/保留地址');
    await expect(assertPublicTarget('localhost')).rejects.toThrow('已禁用私网/保留地址');
  });

  it('域名解析到私网同样被拦（真正的 SSRF 防线在这）', async () => {
    stubDns({ A: ['10.0.0.1'] });
    await expect(assertPublicTarget('evil.example')).rejects.toThrow('解析到了私网/保留地址');
  });

  it('AAAA 里混进私网地址也会被拦（不能只看 A 记录）', async () => {
    stubDns({ A: ['93.184.216.34'], AAAA: ['fd00::1'] });
    await expect(assertPublicTarget('mixed.example')).rejects.toThrow('解析到了私网/保留地址');
  });

  it('解析不到任何地址时明确报错', async () => {
    stubDns({ status: 3 });
    await expect(assertPublicTarget('nope.example')).rejects.toThrow('没有解析到任何地址');
  });

  it('去重并按小写归一（同一个地址重复出现只试一次）', async () => {
    stubDns({ A: ['1.2.3.4', '1.2.3.4'], AAAA: ['2001:4860::1', '2001:4860::1'] });
    await expect(assertPublicTarget('example.com')).resolves.toEqual(['1.2.3.4', '2001:4860::1']);
  });

  it('地址过多时拒绝（防把一次连接变成一场扫描）', async () => {
    stubDns({ A: Array.from({ length: 17 }, (_, i) => `1.2.3.${i + 1}`) });
    await expect(assertPublicTarget('example.com')).rejects.toThrow('解析到过多地址');
  });
});
