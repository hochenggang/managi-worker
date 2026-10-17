import { describe, expect, it } from 'vitest';
import { COLS, ROWS, buildNodeConfig, clampCols, clampRows, validateNode } from '../src/node';
import type { ApiNode } from '../src/protocol';

const base: ApiNode = { host: 'example.com', port: 22, username: 'root', auth_value: 'pw' };
const node = (patch: Partial<ApiNode>): ApiNode => ({ ...base, ...patch });

describe('validateNode', () => {
  it('合法节点通过', () => {
    expect(() => validateNode(base)).not.toThrow();
    expect(() => validateNode(node({ auth_type: 'password' }))).not.toThrow();
    expect(() => validateNode(node({ auth_type: 'key', auth_value: '-----BEGIN OPENSSH PRIVATE KEY-----\nx' })))
      .not.toThrow();
  });

  it('缺 node 直接拒绝', () => {
    expect(() => validateNode(undefined)).toThrow('缺少 node');
    expect(() => validateNode(null as unknown as ApiNode)).toThrow('缺少 node');
    expect(() => validateNode('x' as unknown as ApiNode)).toThrow('缺少 node');
  });

  it('host 空 / 全空格 / 非字符串都拒绝', () => {
    expect(() => validateNode(node({ host: '' }))).toThrow('节点地址(host)为空');
    expect(() => validateNode(node({ host: '   ' }))).toThrow('节点地址(host)为空');
    expect(() => validateNode(node({ host: 123 as unknown as string }))).toThrow('节点地址(host)为空');
  });

  it('端口必须是 1-65535 的整数', () => {
    expect(() => validateNode(node({ port: 1 }))).not.toThrow();
    expect(() => validateNode(node({ port: 65535 }))).not.toThrow();
    expect(() => validateNode(node({ port: 0 }))).toThrow('非法');
    expect(() => validateNode(node({ port: 65536 }))).toThrow('非法');
    expect(() => validateNode(node({ port: 22.5 }))).toThrow('非法');
    expect(() => validateNode(node({ port: '22' as unknown as number }))).toThrow('非法');
    expect(() => validateNode(node({ port: Number.NaN }))).toThrow('非法');
  });

  it('用户名不能为空（空串，但允许有空格——远程可能真叫 "a b"）', () => {
    expect(() => validateNode(node({ username: '' }))).toThrow('登录用户名(username)为空');
    expect(() => validateNode(node({ username: ' ' }))).not.toThrow();
  });

  it('认证内容不能为空', () => {
    expect(() => validateNode(node({ auth_value: '' }))).toThrow('认证内容为空');
    expect(() => validateNode(node({ auth_value: undefined }))).toThrow('认证内容为空');
  });

  it('不认识的认证方式要说清只有两种', () => {
    expect(() => validateNode(node({ auth_type: 'agent' as unknown as 'password' })))
      .toThrow('仅 password / key');
    expect(() => validateNode(node({ auth_type: 'gssapi' as unknown as 'key' })))
      .toThrow('仅 password / key');
  });

  it('auth_type=key 但内容不是 OpenSSH 私钥时给出可操作的提示', () => {
    expect(() => validateNode(node({ auth_type: 'key', auth_value: 'not-a-key' })))
      .toThrow('仅支持未加密的 OpenSSH 格式私钥');
    expect(() => validateNode(node({ auth_type: 'key', auth_value: '-----BEGIN RSA PRIVATE KEY-----' })))
      .toThrow('ssh-keygen');
  });

  it('用密码时不会误判成私钥问题', () => {
    expect(() => validateNode(node({ auth_type: 'password', auth_value: '随便一段' }))).not.toThrow();
  });
});

describe('clampCols / clampRows', () => {
  it('区间内保留原值', () => {
    expect(clampCols(COLS.min)).toBe(COLS.min);
    expect(clampCols(COLS.max)).toBe(COLS.max);
    expect(clampCols(120)).toBe(120);
    expect(clampRows(ROWS.min)).toBe(ROWS.min);
    expect(clampRows(ROWS.max)).toBe(ROWS.max);
    expect(clampRows(40)).toBe(40);
  });

  it('越界与非整数回退到默认尺寸', () => {
    expect(clampCols(COLS.min - 1)).toBe(COLS.fallback);
    expect(clampCols(COLS.max + 1)).toBe(COLS.fallback);
    expect(clampRows(ROWS.min - 1)).toBe(ROWS.fallback);
    expect(clampRows(ROWS.max + 1)).toBe(ROWS.fallback);
    expect(clampCols(80.5)).toBe(COLS.fallback);
    expect(clampCols(undefined)).toBe(COLS.fallback);
    expect(clampRows(null)).toBe(ROWS.fallback);
  });

  it('与 SSH 层 resizePTY 的合法区间保持一致', () => {
    // session.ts 的 resizePTY 用自己的字面量做同一套判断；两边错位会出现
    // 「open 时报了尺寸、resize 时却被静默丢掉」。这里把边界钉住。
    expect(COLS).toEqual({ min: 10, max: 1000, fallback: 80 });
    expect(ROWS).toEqual({ min: 5, max: 1000, fallback: 24 });
  });
});

describe('buildNodeConfig', () => {
  it('密码模式的字段映射', () => {
    expect(buildNodeConfig(base, 100, 30)).toEqual({
      host: 'example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
      password: 'pw',
      privateKey: undefined,
      cols: 100,
      rows: 30,
      term: 'xterm-256color',
    });
  });

  it('私钥模式把 auth_value 放到 privateKey，且不带 password', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----';
    const config = buildNodeConfig(node({ auth_type: 'key', auth_value: key }), 80, 24);
    expect(config.authMethod).toBe('publickey');
    expect(config.privateKey).toBe(key);
    expect(config.password).toBeUndefined();
  });

  it('主机名去掉首尾空格（否则 KV 键与 DNS 查询都会带上空格）', () => {
    expect(buildNodeConfig(node({ host: '  example.com  ' }), 80, 24).host).toBe('example.com');
  });

  it('尺寸非法时用默认值，不让坏尺寸传到协议栈', () => {
    expect(buildNodeConfig(base, 'big', {}).cols).toBe(COLS.fallback);
    expect(buildNodeConfig(base, 'big', {}).rows).toBe(ROWS.fallback);
  });

  it('auth_type 省略时按密码处理（前端老数据没有这个字段）', () => {
    const config = buildNodeConfig(node({ auth_type: undefined }), 80, 24);
    expect(config.authMethod).toBe('password');
    expect(config.password).toBe('pw');
  });
});
