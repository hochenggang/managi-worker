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

export const SUPPORTED_ENCRYPTION_ALGORITHMS = [
  'aes128-gcm@openssh.com',
  'aes256-gcm@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
];

export const SUPPORTED_MAC_ALGORITHMS = [
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
};

export function isCurve25519KEXAlgorithm(algorithm: string): boolean {
  return algorithm === KEX_ALGORITHM_CURVE25519_SHA256
    || algorithm === KEX_ALGORITHM_CURVE25519_SHA256_LIBSSH;
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
