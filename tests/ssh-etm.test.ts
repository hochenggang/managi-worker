// Encrypt-then-MAC —— 我们对 vendored SSH 协议栈的**刻意扩展**（上游 EdgeSSH 完全没有）。
//
// 单测能钉住的是「按规范字节级正确」，钉不住「对方认不认」。互通的验证在
// tests/live/interop.live.ts（真服务器，但它的加密算法全是 AEAD，用不到 ETM）
// 和 README 里写的 paramiko 本地服务端（强制 ctr + etm）。
//
// 规范出处：OpenSSH PROTOCOL §1.5
//   mac = MAC(key, sequence_number || packet_length || encrypted_packet)
//   packet_length 明文发送；encrypted_packet = padding_length || payload || padding
import { describe, expect, it } from 'vitest';

import {
  MAC_ALGORITHM_HMAC_SHA2_256_ETM,
  MAC_ALGORITHM_HMAC_SHA2_512_ETM,
  SUPPORTED_MAC_ALGORITHMS,
  getMacSpec,
  isEtmMacAlgorithm,
} from '../src/ssh/algorithms';
import { SSHHMAC } from '../src/ssh/crypto';
import { KEXInitBuilder, parseKEXInit } from '../src/ssh/kex';
import { SSHPacketBuilder, SSHPacketParser } from '../src/ssh/packet';
import { concat, readUint32, writeUint32 } from '../src/ssh/utils';

const BLOCK = 16;
const MAC_LEN = 32;
const SEQ = 7;

/** 逐字节取反当「加密」：密文与明文不同，才能断言 MAC 覆盖的到底是哪一份。 */
const flip = async (data: Uint8Array): Promise<Uint8Array> => data.map((byte) => byte ^ 0xff);

/** 模拟 SSHHMAC：返回定长字节，并把每次的输入原样记下来备查。 */
function recordingMac() {
  const inputs: Uint8Array[] = [];
  const mac = async (data: Uint8Array, seq: number): Promise<Uint8Array> => {
    inputs.push(new Uint8Array(data));
    const out = new Uint8Array(MAC_LEN);
    for (let i = 0; i < MAC_LEN; i++) out[i] = (data[i % data.length] ?? 0) ^ (seq & 0xff) ^ i;
    return out;
  };
  return { mac, inputs };
}

const payload = (n: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: n }, (_v, i) => (i * 7 + seed) & 0xff);

async function buildEtm(data: Uint8Array, seqNum = SEQ) {
  const { mac, inputs } = recordingMac();
  const wire = await SSHPacketBuilder.build(data, BLOCK, flip, seqNum, false, mac, true);
  return { wire, macInputs: inputs };
}

describe('MAC 算法表：etm 变体', () => {
  it('两个 etm 名都登记在支持列表里', () => {
    expect(SUPPORTED_MAC_ALGORITHMS).toContain(MAC_ALGORITHM_HMAC_SHA2_256_ETM);
    expect(SUPPORTED_MAC_ALGORITHMS).toContain(MAC_ALGORITHM_HMAC_SHA2_512_ETM);
  });

  it('客户端 KEXINIT 真的把它们发出去了', () => {
    const advertised = parseKEXInit(KEXInitBuilder.build()).macS2C;
    expect(advertised).toContain(MAC_ALGORITHM_HMAC_SHA2_256_ETM);
    expect(advertised).toContain(MAC_ALGORITHM_HMAC_SHA2_512_ETM);
  });

  it('etm 的 length 与 keyLength 必须与同名非 etm 一致（keyLength 参与密钥派生，错了会 MAC 校验全败）', () => {
    expect(getMacSpec(MAC_ALGORITHM_HMAC_SHA2_256_ETM)).toEqual(getMacSpec('hmac-sha2-256'));
    expect(getMacSpec(MAC_ALGORITHM_HMAC_SHA2_512_ETM)).toEqual(getMacSpec('hmac-sha2-512'));
  });

  it('isEtmMacAlgorithm 只认 etm 名', () => {
    expect(isEtmMacAlgorithm(MAC_ALGORITHM_HMAC_SHA2_256_ETM)).toBe(true);
    expect(isEtmMacAlgorithm(MAC_ALGORITHM_HMAC_SHA2_512_ETM)).toBe(true);
    expect(isEtmMacAlgorithm('hmac-sha2-256')).toBe(false);
    expect(isEtmMacAlgorithm('none')).toBe(false);
    expect(isEtmMacAlgorithm('')).toBe(false);
  });

  it('不认识的名字仍然拒绝（不会因为剥后缀而放行）', () => {
    expect(() => getMacSpec('hmac-md5-etm@openssh.com')).toThrow(/Unsupported MAC algorithm/);
  });
});

describe('SSHHMAC：etm 变体与同名非 etm 是同一个 HMAC', () => {
  const key = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
  const message = payload(64, 3);

  it('同一个密钥、同一段数据 → 两个名字产出同样的签名', async () => {
    const plain = new SSHHMAC('hmac-sha2-256', key);
    const etm = new SSHHMAC(MAC_ALGORITHM_HMAC_SHA2_256_ETM, key);
    await Promise.all([plain.init(), etm.init()]);

    expect(etm.length).toBe(plain.length);
    expect(await etm.sign(message, 42)).toEqual(await plain.sign(message, 42));
  });

  it('sha2-512 的 etm 变体也一样', async () => {
    const plain = new SSHHMAC('hmac-sha2-512', key);
    const etm = new SSHHMAC(MAC_ALGORITHM_HMAC_SHA2_512_ETM, key);
    await Promise.all([plain.init(), etm.init()]);

    expect(etm.length).toBe(64);
    expect(await etm.sign(message, 1)).toEqual(await plain.sign(message, 1));
  });

  it('换个密钥签名就不同（确认上面比的是真签名，不是巧合）', async () => {
    const a = new SSHHMAC(MAC_ALGORITHM_HMAC_SHA2_256_ETM, key);
    const b = new SSHHMAC(MAC_ALGORITHM_HMAC_SHA2_256_ETM, key.map((v) => v ^ 0x5a));
    await Promise.all([a.init(), b.init()]);
    expect(await a.sign(message, 0)).not.toEqual(await b.sign(message, 0));
  });

  it('未初始化就签名要抛错，不静默返回空', async () => {
    const hmac = new SSHHMAC(MAC_ALGORITHM_HMAC_SHA2_256_ETM, key);
    await expect(hmac.sign(message, 0)).rejects.toThrow(/not initialized/);
  });
});

describe('ETM 发送分帧的字节布局', () => {
  it('长度字段明文、等于密文段长度、且密文段按块对齐', async () => {
    const data = payload(20);
    const { wire } = await buildEtm(data);

    const cipherLen = readUint32(wire, 0);
    expect(cipherLen % BLOCK).toBe(0);
    // 长度字段是明文：直接读原始字节就得到密文长度，说明它没被加密。
    expect(wire.length).toBe(4 + cipherLen + MAC_LEN);
  });

  it('密文段 = 取反后的 (padding_length ‖ payload ‖ padding)，载荷可原样取回', async () => {
    const data = payload(20);
    const { wire } = await buildEtm(data);
    const cipherLen = readUint32(wire, 0);
    const body = await flip(wire.subarray(4, 4 + cipherLen));

    const paddingLength = body[0]!;
    expect(paddingLength).toBeGreaterThanOrEqual(4);
    expect(body.length).toBe(1 + data.length + paddingLength);
    expect(body.subarray(1, 1 + data.length)).toEqual(data);
  });

  it('MAC 覆盖「长度字段 ‖ 密文」，不是明文', async () => {
    const data = payload(20);
    const { wire, macInputs } = await buildEtm(data);
    const cipherLen = readUint32(wire, 0);

    expect(macInputs).toHaveLength(1);
    const covered = macInputs[0]!;
    expect(covered.length).toBe(4 + cipherLen);
    expect(covered.subarray(0, 4)).toEqual(wire.subarray(0, 4));
    // 是密文（线上那几个字节）……
    expect(covered.subarray(4)).toEqual(wire.subarray(4, 4 + cipherLen));
    // ……而不是明文。
    const plaintext = await flip(wire.subarray(4, 4 + cipherLen));
    expect(covered.subarray(4)).not.toEqual(plaintext);
  });

  it('对照：传统分帧的 MAC 覆盖的是明文（含长度字段）—— 这才是 ETM 改掉的东西', async () => {
    const data = payload(20);
    const { mac, inputs } = recordingMac();
    const legacyWire = await SSHPacketBuilder.build(data, BLOCK, flip, SEQ, false, mac, false);

    expect(inputs).toHaveLength(1);
    // 传统模式下 mac 收到的是拼好的明文整包，其中前 4 字节是长度字段。
    // 注意只取反前 inputs[0].length 字节 —— 线上那串尾巴是 MAC 本身，不在明文里。
    const plaintext = await flip(legacyWire.subarray(0, inputs[0]!.length));
    expect(inputs[0]).toEqual(plaintext);
    expect(readUint32(inputs[0]!, 0)).toBe(plaintext.length - 4);
  });

  it('对短载荷也要让步长够（padding 至少 4 字节）', async () => {
    for (const size of [0, 1, 5, 15, 16, 17, 100]) {
      const data = payload(size, size);
      const { wire } = await buildEtm(data);
      const cipherLen = readUint32(wire, 0);
      const body = await flip(wire.subarray(4, 4 + cipherLen));
      expect(body[0]!).toBeGreaterThanOrEqual(4);
      expect(cipherLen % BLOCK).toBe(0);
      expect(cipherLen).toBe(1 + size + body[0]!);
    }
  });
});

describe('ETM 接收分帧', () => {
  async function parseWire(wire: Uint8Array, options: { verifyResult?: boolean } = {}) {
    const log: string[] = [];
    const verifyInputs: Uint8Array[] = [];
    const verifySeqs: number[] = [];
    const verify = async (data: Uint8Array, _mac: Uint8Array, seq: number): Promise<boolean> => {
      log.push('verify');
      verifyInputs.push(new Uint8Array(data));
      verifySeqs.push(seq);
      return options.verifyResult ?? true;
    };
    const decrypt = async (data: Uint8Array): Promise<Uint8Array> => {
      log.push('decrypt');
      return flip(data);
    };

    const parser = new SSHPacketParser();
    parser.feed(wire);
    const packet = await parser.nextPacket(BLOCK, decrypt, false, MAC_LEN, verify, true);
    return { packet, log, verifyInputs, verifySeqs, parser };
  }

  it('收发往返：载荷与序号都对得上', async () => {
    const data = payload(37);
    const { wire } = await buildEtm(data);
    const { packet, parser, verifySeqs } = await parseWire(wire);

    expect(packet).not.toBeNull();
    expect(packet!.payload).toEqual(data);
    expect(packet!.length).toBe(readUint32(wire, 0));
    // 解析器的序号是它自己数的，从 0 开始 —— SEQ=7 是发送方那边的。
    expect(verifySeqs).toEqual([0]);
    // 序号推进过了，下一包用新序号。
    expect(parser.getSeqNum()).toBe(1);
  });

  it('校验用的正是「长度字段 ‖ 密文」', async () => {
    const data = payload(37);
    const { wire } = await buildEtm(data);
    const { verifyInputs } = await parseWire(wire);
    expect(verifyInputs[0]).toEqual(wire.subarray(0, wire.length - MAC_LEN));
  });

  it('**先验 MAC 再解密** —— 这是 ETM 存在的全部理由', async () => {
    const { wire } = await buildEtm(payload(20));
    const { log } = await parseWire(wire);
    expect(log).toEqual(['verify', 'decrypt']);
  });

  it('MAC 不通过时直接抛错，且一个字节都没喂给解密器', async () => {
    const { wire } = await buildEtm(payload(20));
    const log: string[] = [];
    const parser = new SSHPacketParser();
    parser.feed(wire);
    await expect(parser.nextPacket(BLOCK, async (d) => {
      log.push('decrypt');
      return flip(d);
    }, false, MAC_LEN, async () => {
      log.push('verify');
      return false;
    }, true)).rejects.toThrow(/Invalid packet MAC/);
    expect(log).toEqual(['verify']);
  });

  it('数据没凑齐时返回 null 而不是抛错（TCP 分片是常态）', async () => {
    const { wire } = await buildEtm(payload(20));
    for (const cut of [1, 3, 4, 5, wire.length - MAC_LEN - 1, wire.length - 1]) {
      const parser = new SSHPacketParser();
      parser.feed(wire.subarray(0, cut));
      const packet = await parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, true);
      expect(packet, `cut=${cut}`).toBeNull();
    }
  });

  it('分两次喂也能拼出完整包', async () => {
    const data = payload(20);
    const { wire } = await buildEtm(data);
    const parser = new SSHPacketParser();
    parser.feed(wire.subarray(0, 6));
    expect(await parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, true)).toBeNull();
    parser.feed(wire.subarray(6));
    const packet = await parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, true);
    expect(packet!.payload).toEqual(data);
  });

  it('密文段未按块对齐 → 抛错（长度字段是明文，这个检查才做得到）', async () => {
    const bogus = new Uint8Array(4 + BLOCK + MAC_LEN);
    writeUint32(bogus, 0, BLOCK - 8);
    const parser = new SSHPacketParser();
    parser.feed(bogus);
    await expect(parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, true))
      .rejects.toThrow(/not aligned to block size/);
  });

  it('长度字段超出上限 → 抛错，不当成正常包继续读', async () => {
    const bogus = new Uint8Array(4 + 4 + MAC_LEN);
    writeUint32(bogus, 0, 4);
    const parser = new SSHPacketParser();
    parser.feed(bogus);
    await expect(parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, true))
      .rejects.toThrow(/below the SSH minimum/);
  });

  it('padding_length 非法 → 抛错（不会拿越界区间当载荷）', async () => {
    const body = new Uint8Array(BLOCK);
    body[0] = BLOCK; // padding_length 不能 >= packet_length
    const cipher = await flip(body);
    const wire = concat(Uint32(BLOCK), cipher, new Uint8Array(MAC_LEN));
    const parser = new SSHPacketParser();
    parser.feed(wire);
    await expect(parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, true))
      .rejects.toThrow(/Invalid padding length/);
  });

  it('macLength 为 0 却开了 ETM → 直接抛错，不静默跳过校验', async () => {
    const { wire } = await buildEtm(payload(20));
    const parser = new SSHPacketParser();
    parser.feed(wire);
    await expect(parser.nextPacket(BLOCK, flip, false, 0, undefined, true))
      .rejects.toThrow(/requires an active MAC/);
  });

  it('没开 ETM 时走老路：长度字段在密文里，结果同样正确', async () => {
    const data = payload(20);
    const { mac } = recordingMac();
    const wire = await SSHPacketBuilder.build(data, BLOCK, flip, SEQ, false, mac, false);
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const packet = await parser.nextPacket(BLOCK, flip, false, MAC_LEN, async () => true, false);
    expect(packet!.payload).toEqual(data);
  });
});

function Uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  writeUint32(out, 0, value);
  return out;
}
