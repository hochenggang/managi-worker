// SSH 算法表。
//
// src/ssh/ 整体是逐字保留的上游协议栈（见 vitest.config.ts：不计入覆盖率分母），
// 但本文件测的是**我们对它的刻意修改**：补上 curve25519-sha256@libssh.org 这个名字。
// 这类修改必须有断言钉住，否则下次同步上游会被静默回退，而症状是「连不上某台服务器」——
// 离修改点很远，极难回溯。
import { describe, expect, it } from 'vitest';

import {
  KEX_ALGORITHM_CURVE25519_SHA256,
  KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH,
  KEX_ALGORITHM_ECDH_NISTP256,
  SUPPORTED_KEX_ALGORITHMS,
  getCipherSpec,
  getMacSpec,
  isCurve25519KEXAlgorithm,
} from '../src/ssh/algorithms';
import { KEXInitBuilder, filterExtInfo, negotiate, parseKEXInit } from '../src/ssh/kex';

/** 复现线上那台服务器 advertise 的 KEX 列表（原样取自报错信息）。 */
const REPORTED_SERVER_KEX = [
  'curve25519-sha256@libssh.org',
  'diffie-hellman-group-exchange-sha256',
  'kex-strict-s-v00@openssh.com',
];

/** 走一遍 session.ts 选 KEX 的同一套流程：剥掉 ext-info-，再按客户端偏好求交集。 */
const pickKex = (serverKex: string[]): string =>
  negotiate(
    filterExtInfo(SUPPORTED_KEX_ALGORITHMS),
    filterExtInfo(serverKex),
    '密钥交换算法',
  );

describe('SUPPORTED_KEX_ALGORITHMS', () => {
  it('同时登记 curve25519-sha256 的旧名与新名', () => {
    expect(SUPPORTED_KEX_ALGORITHMS).toContain(KEX_ALGORITHM_CURVE25519_SHA256);
    expect(SUPPORTED_KEX_ALGORITHMS).toContain(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH);
    expect(SUPPORTED_KEX_ALGORITHMS).toContain(KEX_ALGORITHM_ECDH_NISTP256);
  });

  it('两个名字确实是不同的字符串（协商是精确匹配，别名必须在列表里各占一格）', () => {
    expect(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH).toBe('curve25519-sha256@libssh.org');
    expect(KEX_ALGORITHM_CURVE25519_SHA256).toBe('curve25519-sha256');
    expect(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH).not.toBe(KEX_ALGORITHM_CURVE25519_SHA256);
  });

  it('没有重复项（重复会让客户端偏好顺序含混）', () => {
    expect(new Set(SUPPORTED_KEX_ALGORITHMS).size).toBe(SUPPORTED_KEX_ALGORITHMS.length);
  });

  it('标准名仍排在旧名前面：两边都支持时不改变既有偏好顺序', () => {
    expect(SUPPORTED_KEX_ALGORITHMS.indexOf(KEX_ALGORITHM_CURVE25519_SHA256))
      .toBeLessThan(SUPPORTED_KEX_ALGORITHMS.indexOf(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH));
  });
});

describe('isCurve25519KEXAlgorithm', () => {
  it('两个名字都认（漏掉旧名会让分派落到 ECDH 分支，算出错误的共享密钥）', () => {
    expect(isCurve25519KEXAlgorithm(KEX_ALGORITHM_CURVE25519_SHA256)).toBe(true);
    expect(isCurve25519KEXAlgorithm(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH)).toBe(true);
  });

  it('别的算法不认', () => {
    expect(isCurve25519KEXAlgorithm(KEX_ALGORITHM_ECDH_NISTP256)).toBe(false);
    expect(isCurve25519KEXAlgorithm('diffie-hellman-group-exchange-sha256')).toBe(false);
    expect(isCurve25519KEXAlgorithm('kex-strict-s-v00@openssh.com')).toBe(false);
    expect(isCurve25519KEXAlgorithm('')).toBe(false);
  });

  it('不做前缀/模糊匹配（curve25519 开头的假名字不该蒙混过关）', () => {
    expect(isCurve25519KEXAlgorithm('curve25519-sha256@libssh.org.evil')).toBe(false);
    expect(isCurve25519KEXAlgorithm('curve25519-sha256-')).toBe(false);
  });
});

describe('协商：报错那台服务器', () => {
  it('现在能谈成（修复前这里抛 No common …）', () => {
    expect(pickKex(REPORTED_SERVER_KEX)).toBe(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH);
  });

  it('谈成之后仍走 Curve25519 分支（这才是修复真正要保住的不变量）', () => {
    expect(isCurve25519KEXAlgorithm(pickKex(REPORTED_SERVER_KEX))).toBe(true);
  });

  it('只提供旧名的服务器：其它算法都指望不上时仍能连上', () => {
    expect(pickKex(['curve25519-sha256@libssh.org'])).toBe(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH);
  });

  it('同时提供两个名字时优先选标准名（与 OpenSSH 一致）', () => {
    expect(pickKex([KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH, KEX_ALGORITHM_CURVE25519_SHA256]))
      .toBe(KEX_ALGORITHM_CURVE25519_SHA256);
  });

  it('只提供 ECDH 的服务器照旧走 ECDH', () => {
    expect(pickKex([KEX_ALGORITHM_ECDH_NISTP256])).toBe(KEX_ALGORITHM_ECDH_NISTP256);
  });

  it('真正无交集时仍然如实报错，不静默降级', () => {
    expect(() => pickKex(['diffie-hellman-group-exchange-sha256']))
      .toThrow(/No common 密钥交换算法/);
  });

  it('strict-kex 标记位不参与选择（它不是真算法，只是防 Terrapin 的能力位）', () => {
    // 该标记位在列表里，但两边都不会选中它。
    expect(pickKex(['kex-strict-s-v00@openssh.com', KEX_ALGORITHM_CURVE25519_SHA256]))
      .toBe(KEX_ALGORITHM_CURVE25519_SHA256);
  });
});

describe('客户端 KEXINIT 真的把旧名发出去了', () => {
  // 上面测的是常量表；这里测「表 → 报文 → 解析回来」这条链没断。
  const roundTrip = filterExtInfo(parseKEXInit(KEXInitBuilder.build()).kexAlgorithms);

  it('报文里含 ext-info-c（所以解析回来必须剥掉才算数）', () => {
    expect(parseKEXInit(KEXInitBuilder.build()).kexAlgorithms).toContain('ext-info-c');
  });

  it('剥掉 ext-info-c 之后就是支持列表本身', () => {
    expect(roundTrip).toEqual([...SUPPORTED_KEX_ALGORITHMS]);
  });

  it('旧名确实在线上列表里，且与上报的服务器列表能谈成', () => {
    expect(roundTrip).toContain(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH);
    expect(
      negotiate(roundTrip, filterExtInfo(REPORTED_SERVER_KEX), '密钥交换算法'),
    ).toBe(KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH);
  });
});

describe('加别名没有顺带放宽别的算法', () => {
  it('加密算法表不含 chacha20-poly1305 与 CBC（Terrapin 影响面，刻意不引入）', () => {
    const ciphers = KEXInitBuilder.build();
    const parsed = parseKEXInit(ciphers);
    for (const name of parsed.encryptionC2S) {
      expect(name).not.toContain('chacha20');
      expect(name).not.toContain('cbc');
    }
  });

  it('未知算法仍然拒绝，spec 查找失败会抛错', () => {
    expect(() => getCipherSpec('aes256-cbc')).toThrow(/Unsupported cipher/);
    expect(() => getMacSpec('hmac-md5')).toThrow(/Unsupported MAC algorithm/);
  });
});
