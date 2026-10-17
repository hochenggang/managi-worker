export const KEX_ALGORITHM_CURVE25519_SHA256 = 'curve25519-sha256';

// curve25519-sha256 标准化之前的旧名。RFC 8731 明确它是同一个算法：
// "the algorithm described is equivalent to the privately defined algorithm
//  curve25519-sha256@libssh.org"。二者的 X25519 计算与报文格式逐比特相同，
// 差别只在名字，所以等价于别名 —— 但协商是精确字符串匹配，必须在列表里各列一份。
// 有些服务器（裁剪过的 sshd、非 OpenSSH 实现）只 advertise 这个名字。
export const KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH = 'curve25519-sha256@libssh.org';

export const KEX_ALGORITHM_ECDH_NISTP256 = 'ecdh-sha2-nistp256';

export const SUPPORTED_KEX_ALGORITHMS = [
  KEX_ALGORITHM_CURVE25519_SHA256,
  // 标准名排在前面：两边都支持时优先走标准名，不改变既有偏好顺序。
  KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH,
  KEX_ALGORITHM_ECDH_NISTP256,
];

/**
 * 密钥交换的「族」：协商是精确字符串匹配，但**实现只按族分派**。
 *
 * 上游把「哪些名字算 curve25519」写成 `a === 'x' || a === 'y'` 的谓词，于是每加一个
 * 线上别名（历史上就有标准名与 libssh 旧名两个），判断逻辑与选择逻辑会各改一处，
 * 漏改的症状是「握手谈成了，却用错实现」或者「别名谈了但没人认」。
 * 这张表把「名字 → 实现」收成唯一事实，加别名只追加一行。
 */
export type KexFamily = 'curve25519' | 'ecdh-nistp256';

const KEX_FAMILIES: Readonly<Record<string, KexFamily>> = {
  [KEX_ALGORITHM_CURVE25519_SHA256]: 'curve25519',
  [KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH]: 'curve25519',
  [KEX_ALGORITHM_ECDH_NISTP256]: 'ecdh-nistp256',
};

/** kexFamily 取算法名对应的实现族；不支持的算法抛错（不会静默落到某个默认实现）。 */
export function kexFamily(algorithm: string): KexFamily {
  const family = KEX_FAMILIES[algorithm];
  if (!family) throw new Error(`Unsupported KEX algorithm: ${algorithm}`);
  return family;
}

/** 已登记的名字集合。导出来只是为了测试能校验「偏好列表与族表不缺不多」。 */
export function supportedKexNames(): string[] {
  return Object.keys(KEX_FAMILIES);
}

export const SUPPORTED_ENCRYPTION_ALGORITHMS = [
  'aes128-gcm@openssh.com',
  'aes256-gcm@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
];

// Encrypt-then-MAC 变体（OpenSSH PROTOCOL §1.5）。名字带 "-etm"，但**不是别名** ——
// HMAC 本身与同名非 etm 完全一样，区别在报文分帧：MAC 覆盖密文而不是明文，且 packet_length
// 以明文发送。握手时这两个名字与非 etm 的名字是并列的可选项，需要各自登记。
export const MAC_ALGORITHM_HMAC_SHA2_256_ETM = 'hmac-sha2-256-etm@openssh.com';
export const MAC_ALGORITHM_HMAC_SHA2_512_ETM = 'hmac-sha2-512-etm@openssh.com';

// ETM 排在前（与 OpenSSH 的默认顺序一致）：它能消除「解密未认证密文」这个 oracle。
// 实际只有协商到非 AEAD 密码时才会用到 —— 我们的加密算法偏好把 aes*-gcm 排在前面，
// 所以 AEAD 连接上这两项根本不参与（AEAD 路径 MAC 一律置 none）。
export const SUPPORTED_MAC_ALGORITHMS = [
  MAC_ALGORITHM_HMAC_SHA2_256_ETM,
  MAC_ALGORITHM_HMAC_SHA2_512_ETM,
  'hmac-sha2-256',
  'hmac-sha2-512',
];

export interface CipherSpec {
  mode: 'gcm' | 'ctr';
  blockSize: number;
  ivLength: number;
  keyLength: number;
  aead: boolean;
}

export interface MacSpec {
  length: number;
  keyLength: number;
}

const CIPHER_SPECS: Record<string, CipherSpec> = {
  'aes256-gcm@openssh.com': { mode: 'gcm', blockSize: 16, ivLength: 12, keyLength: 32, aead: true },
  'aes128-gcm@openssh.com': { mode: 'gcm', blockSize: 16, ivLength: 12, keyLength: 16, aead: true },
  'aes256-ctr': { mode: 'ctr', blockSize: 16, ivLength: 16, keyLength: 32, aead: false },
  'aes192-ctr': { mode: 'ctr', blockSize: 16, ivLength: 16, keyLength: 24, aead: false },
  'aes128-ctr': { mode: 'ctr', blockSize: 16, ivLength: 16, keyLength: 16, aead: false },
};

const MAC_SPECS: Record<string, MacSpec> = {
  none: { length: 0, keyLength: 32 },
  'hmac-sha2-256': { length: 32, keyLength: 32 },
  'hmac-sha2-512': { length: 64, keyLength: 64 },
  // etm 变体的 length / keyLength 与同名非 etm **必须一致**：keyLength 参与密钥派生，
  // 改错会让两端派生出不同的完整性密钥，症状是「握手过、第一个报文就 MAC 校验失败」。
  [MAC_ALGORITHM_HMAC_SHA2_256_ETM]: { length: 32, keyLength: 32 },
  [MAC_ALGORITHM_HMAC_SHA2_512_ETM]: { length: 64, keyLength: 64 },
};

/** 这个名字是不是 curve25519 族 —— 报文格式与实现都按族走。 */
export function isCurve25519KEXAlgorithm(algorithm: string): boolean {
  return KEX_FAMILIES[algorithm] === 'curve25519';
}

/** 这个名字是不是 Encrypt-then-MAC 变体 —— 报文分帧要据此切换。 */
export function isEtmMacAlgorithm(algorithm: string): boolean {
  return algorithm.endsWith('-etm@openssh.com');
}

export function getCipherSpec(algorithm: string): CipherSpec {
  const spec = CIPHER_SPECS[algorithm];
  if (!spec) throw new Error(`Unsupported cipher: ${algorithm}`);
  return spec;
}

export function getMacSpec(algorithm: string): MacSpec {
  const spec = MAC_SPECS[algorithm];
  if (!spec) throw new Error(`Unsupported MAC algorithm: ${algorithm}`);
  return spec;
}
