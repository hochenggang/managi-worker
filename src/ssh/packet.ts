import { SSHPacket } from '../types';
import { concat, readUint32, writeUint32 } from './utils';

const EMPTY_BUFFER = new Uint8Array(0);
const COMPACT_CHUNKS_THRESHOLD = 32;
/** SSH 层单包上限（RFC 4253 §6.1 要求至少支持 35000 字节）。与通道层的窗口片大小是两件事。 */
const MAX_SSH_PACKET_SIZE = 256 * 1024;
const MIN_PACKET_LENGTH = 5; // padding_length + at least 4 bytes of padding

export function nextSequenceNumber(value: number): number {
  return (value + 1) >>> 0;
}

/** 解密器：commit=false 用于「只看包头」的那一趟，不推进 IV / 计数器。 */
export type PacketDecryptor = (
  data: Uint8Array,
  seq: number,
  aad?: Uint8Array,
  commit?: boolean,
) => Uint8Array | Promise<Uint8Array | null> | null;

export type PacketMacVerifier = (packet: Uint8Array, mac: Uint8Array, seq: number) => boolean | Promise<boolean>;

export type PacketEncryptor = (data: Uint8Array, seq: number, aad?: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export type PacketMacSigner = (packet: Uint8Array, seq: number) => Uint8Array | Promise<Uint8Array>;

/**
 * 一次解包的全部参数。
 *
 * 这里刻意用具名对象而不是位置参数：加 ETM 时参数已经长到「6 个值 + 3 个布尔」，
 * 而 `nextPacket(16, decrypt, false, 32, verify, true)` 把 macLength 与 blockSize
 * 传颠倒不会有任何类型错误 —— 只会解出乱码，再由某个下游检查报一个看不懂的错。
 * 报文解析是安全敏感路径，每个值都必须带名字。
 */
export interface PacketReadOptions {
  /** 当前入站加密的分块大小；明文阶段传 8。 */
  blockSize: number;
  /** 已加密时传解密器；明文阶段传恒等函数。 */
  decrypt: PacketDecryptor;
  /** 密码是 AEAD（GCM）：packet_length 作 AAD，密文自带 tag，没有独立 MAC。 */
  aead?: boolean;
  /** 非 AEAD 的 MAC 字节长度；AEAD 与明文阶段为 0。 */
  macLength?: number;
  /** 有 MAC 时必须给：验签回调（内部会拼 sequence_number）。 */
  verifyMac?: PacketMacVerifier;
  /** 这个 MAC 是 Encrypt-then-MAC 变体（OpenSSH PROTOCOL §1.5）。 */
  encryptThenMac?: boolean;
}

/** 一次组包的全部参数，理由同上。 */
export interface PacketWriteOptions {
  /** 分块大小（出站密码的）。 */
  blockSize: number;
  /** 已加密时传加密器；明文阶段传 null。 */
  encrypt: PacketEncryptor | null;
  seqNum: number;
  /** 密码是 AEAD：padding_length||payload 整体加密，长度字段明文作 AAD。 */
  aead?: boolean;
  /** 非 AEAD 的 MAC 回调。 */
  mac?: PacketMacSigner;
  /** 这个 MAC 是 EtM 变体。 */
  encryptThenMac?: boolean;
}

export class SSHPacketParser {
  private chunks: Uint8Array[] = [];
  private chunkIndex: number = 0;
  private readOffset: number = 0;
  private bufferedLength: number = 0;
  private seqNum: number = 0;

  feed(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }

    this.chunks.push(data);
    this.bufferedLength += data.length;
  }

  private peekBytes(bytes: number): Uint8Array | null {
    if (bytes === 0) {
      return EMPTY_BUFFER;
    }

    if (this.bufferedLength < bytes) {
      return null;
    }

    const first = this.chunks[this.chunkIndex];
    if (first) {
      const firstAvailable = first.length - this.readOffset;
      if (firstAvailable >= bytes) {
        return first.subarray(this.readOffset, this.readOffset + bytes);
      }
    }

    const result = new Uint8Array(bytes);
    let copied = 0;

    for (let i = this.chunkIndex; copied < bytes; i++) {
      const chunk = this.chunks[i];
      const start = i === this.chunkIndex ? this.readOffset : 0;
      const take = Math.min(chunk.length - start, bytes - copied);
      result.set(chunk.subarray(start, start + take), copied);
      copied += take;
    }

    return result;
  }

  private readBytes(bytes: number): Uint8Array | null {
    const result = this.peekBytes(bytes);
    if (!result) {
      return null;
    }

    this.consumeBytes(bytes);
    return result;
  }

  private consumeBytes(bytes: number): void {
    if (bytes === 0) {
      return;
    }

    if (bytes > this.bufferedLength) {
      throw new Error('Cannot consume more bytes than buffered');
    }

    this.bufferedLength -= bytes;

    while (bytes > 0) {
      const chunk = this.chunks[this.chunkIndex];
      const available = chunk.length - this.readOffset;

      if (bytes < available) {
        this.readOffset += bytes;
        this.compactChunks();
        return;
      }

      bytes -= available;
      this.chunkIndex++;
      this.readOffset = 0;
    }

    this.compactChunks();
  }

  private compactChunks(): void {
    if (this.bufferedLength === 0) {
      this.chunks = [];
      this.chunkIndex = 0;
      this.readOffset = 0;
      return;
    }

    // Discard fully consumed chunks (Array.slice creates a new reference array,
    if (
      this.chunkIndex > COMPACT_CHUNKS_THRESHOLD &&
      this.chunkIndex * 2 >= this.chunks.length
    ) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
  }

  async nextPacket(options: PacketReadOptions): Promise<SSHPacket | null> {
    const {
      blockSize,
      decrypt,
      aead = false,
      macLength = 0,
      verifyMac,
      encryptThenMac = false,
    } = options;

    if (!Number.isInteger(blockSize) || blockSize < 4) {
      throw new Error(`Invalid SSH cipher block size ${blockSize}`);
    }
    // 声明了 MAC 却不验签，等于悄悄放弃完整性保护。这种组合只可能来自参数写错，
    // 在这里拦住比让报文一路解到业务层再出怪错要好。
    if (macLength > 0 && verifyMac === undefined) {
      throw new Error('Packet MAC length is set but no verifier was provided');
    }

    if (aead) {
      const lengthBytes = this.peekBytes(4);
      if (!lengthBytes) return null;

      const packetLength = readUint32(lengthBytes, 0);
      if (packetLength < MIN_PACKET_LENGTH) throw new Error(`Packet length ${packetLength} is below the SSH minimum`);
      if (packetLength > MAX_SSH_PACKET_SIZE) {
        throw new Error(`Packet length ${packetLength} exceeds maximum allowed size ${MAX_SSH_PACKET_SIZE}`);
      }
      // RFC 5647 section 7.2 makes packet_length AAD. The remaining
      // packetLength bytes are the AES-GCM plaintext and must be block-aligned.
      if (packetLength % blockSize !== 0) {
        throw new Error(`Authenticated packet length ${packetLength} is not aligned to block size ${blockSize}`);
      }
      const expectedSize = 4 + packetLength + 16;

      if (this.bufferedLength < expectedSize) return null;

      const raw = this.readBytes(expectedSize);
      if (!raw) return null;

      const lengthField = raw.subarray(0, 4);
      const dataToDecrypt = raw.subarray(4);
      const decrypted = await decrypt(dataToDecrypt, this.seqNum, lengthField, true);
      if (!decrypted) throw new Error('Authenticated packet decryption failed');
      if (decrypted.length !== packetLength) {
        throw new Error(`Authenticated packet body length ${decrypted.length} does not match packet length ${packetLength}`);
      }

      const paddingLength = decrypted[0];
      if (paddingLength < 4 || paddingLength >= packetLength) {
        throw new Error(`Invalid padding length ${paddingLength} for packet length ${packetLength}`);
      }
      const payload = decrypted.subarray(1, 1 + packetLength - 1 - paddingLength);

      this.seqNum = nextSequenceNumber(this.seqNum);

      return {
        length: packetLength,
        paddingLength,
        payload,
        mac: raw.subarray(4 + packetLength),
      };
    }

    if (encryptThenMac) {
      // Encrypt-then-MAC（OpenSSH PROTOCOL §1.5）：
      //   mac = MAC(key, sequence_number || packet_length || encrypted_packet)
      // packet_length 以**明文**发送，密文里只有 padding_length || payload || padding。
      // 明文长度正是这个模式的目的：先验 MAC 再解密，不再把未认证的密文喂给解密器。
      if (macLength === 0) {
        // ETM 报文必定带 MAC，且它的长度字段是明文 —— 拿明文的 KEX 报文按 ETM 拆会
        // 被下面的对齐检查拒掉（明文包的 packetLength ≡ 4 mod 8）。与其崩在难懂的地方，
        // 不如在这里说清楚：这个模式只在加密已启用时成立。
        throw new Error('Encrypt-then-MAC framing requires an active MAC (macLength > 0)');
      }

      const lengthBytes = this.peekBytes(4);
      if (!lengthBytes) return null;

      const packetLength = readUint32(lengthBytes, 0);
      if (packetLength < MIN_PACKET_LENGTH) throw new Error(`Packet length ${packetLength} is below the SSH minimum`);
      if (packetLength > MAX_SSH_PACKET_SIZE) {
        throw new Error(`Packet length ${packetLength} exceeds maximum allowed size ${MAX_SSH_PACKET_SIZE}`);
      }
      // 长度字段不在密文里，所以要对齐 blockSize 的只有密文那一段。
      if (packetLength % blockSize !== 0) {
        throw new Error(`Encrypt-then-MAC packet length ${packetLength} is not aligned to block size ${blockSize}`);
      }

      const expectedSize = 4 + packetLength + macLength;
      if (this.bufferedLength < expectedSize) return null;

      const raw = this.readBytes(expectedSize);
      if (!raw) return null;

      const lengthField = raw.subarray(0, 4);
      const ciphertext = raw.subarray(4, 4 + packetLength);
      const mac = raw.subarray(4 + packetLength);

      // 顺序是重点：**验签在解密之前**。verifyMac 内部会拼上 sequence_number，
      // 所以这里传「长度字段 ‖ 密文」得到的正是 seq || packet_length || ciphertext。
      if (verifyMac && macLength > 0) {
        const macValid = await verifyMac(concat(lengthField, ciphertext), mac, this.seqNum);
        if (!macValid) throw new Error('Invalid packet MAC');
      }

      const decrypted = await decrypt(ciphertext, this.seqNum, undefined, true);
      if (!decrypted) throw new Error('Packet decryption failed');
      if (decrypted.length !== packetLength) {
        throw new Error(`Decrypted packet size ${decrypted.length} does not match framed size ${packetLength}`);
      }

      const paddingLength = decrypted[0];
      if (paddingLength < 4 || paddingLength >= packetLength) {
        throw new Error(`Invalid padding length ${paddingLength} for packet length ${packetLength}`);
      }
      const payload = decrypted.subarray(1, packetLength - paddingLength);

      this.seqNum = nextSequenceNumber(this.seqNum);

      return {
        length: packetLength,
        paddingLength,
        payload,
        mac,
      };
    }

    const encryptedHeader = this.peekBytes(blockSize);
    if (!encryptedHeader) return null;
    const header = await decrypt(
      encryptedHeader, this.seqNum, undefined, false
    );
    if (!header) throw new Error('Packet header decryption failed');

    const packetLength = readUint32(header, 0);
    if (packetLength < MIN_PACKET_LENGTH) throw new Error(`Packet length ${packetLength} is below the SSH minimum`);
    if (packetLength > MAX_SSH_PACKET_SIZE) {
      throw new Error(`Packet length ${packetLength} exceeds maximum allowed size ${MAX_SSH_PACKET_SIZE}`);
    }

    const totalSize = 4 + packetLength;
    if (totalSize % blockSize !== 0) {
      throw new Error(`Packet size ${totalSize} is not aligned to block size ${blockSize}`);
    }

    if (this.bufferedLength < totalSize + macLength) return null;

    const encryptedPacket = this.readBytes(totalSize);
    const mac = this.readBytes(macLength);
    if (!encryptedPacket || !mac) return null;

    const decrypted = await decrypt(encryptedPacket, this.seqNum, undefined, true);
    if (!decrypted) throw new Error('Packet decryption failed');
    if (decrypted.length !== totalSize) {
      throw new Error(`Decrypted packet size ${decrypted.length} does not match framed size ${totalSize}`);
    }

    if (verifyMac && macLength > 0) {
      const macValid = await verifyMac(decrypted, mac, this.seqNum);
      if (!macValid) {
        throw new Error('Invalid packet MAC');
      }
    }

    const paddingLength = decrypted[4];
    if (paddingLength < 4 || paddingLength >= packetLength) {
      throw new Error(`Invalid padding length ${paddingLength} for packet length ${packetLength}`);
    }
    const payload = decrypted.subarray(5, 5 + packetLength - 1 - paddingLength);

    this.seqNum = nextSequenceNumber(this.seqNum);

    return {
      length: packetLength,
      paddingLength,
      payload,
      mac,
    };
  }

  getSeqNum(): number {
    return this.seqNum;
  }

  getBufferLength(): number {
    return this.bufferedLength;
  }
}

export class SSHPacketBuilder {
  static async build(payload: Uint8Array, options: PacketWriteOptions): Promise<Uint8Array> {
    return SSHPacketBuilder.buildWithPayloadWriter(
      payload.length,
      (packet, offset) => packet.set(payload, offset),
      options,
    );
  }

  static async buildWithPayloadWriter(
    payloadLength: number,
    writePayload: (packet: Uint8Array, offset: number) => void,
    options: PacketWriteOptions,
  ): Promise<Uint8Array> {
    const {
      blockSize,
      encrypt,
      seqNum,
      aead = false,
      mac,
      encryptThenMac = false,
    } = options;

    const packetLength = 1 + payloadLength;
    // 三种分帧的对齐对象不同：
    //   · AEAD 与 ETM：长度字段在密文外，只对齐密文段 (padding_length + payload + padding)；
    //   · 其余（RFC 4253）：长度字段也在密文里，整个 (4 + 密文段) 一起对齐。
    const alignBase = aead || encryptThenMac
      ? (1 + payloadLength) % blockSize      // 加密段本身
      : (4 + packetLength) % blockSize;        // 整包（含 4 字节长度字段）
    const paddingNeeded = blockSize - (alignBase || blockSize);
    const paddingLength = paddingNeeded < 4
      ? paddingNeeded + blockSize
      : paddingNeeded;

    const totalLength = 4 + 1 + payloadLength + paddingLength;
    const packet = new Uint8Array(totalLength);

    const pl = 1 + payloadLength + paddingLength;
    writeUint32(packet, 0, pl);

    packet[4] = paddingLength;

    writePayload(packet, 5);

    crypto.getRandomValues(packet.subarray(5 + payloadLength));

    if (encrypt) {
      if (encryptThenMac) {
        // 复用上面已经拼好的明文：前 4 字节是长度字段（明文发出去），
        // 第 4 字节起正好是 padding_length || payload || padding 这一段，拿去加密。
        const lengthField = packet.subarray(0, 4);
        const body = packet.subarray(4);

        const encryptedBody = await encrypt(body, seqNum);
        // mac 回调内部会拼上 sequence_number，所以传「长度 ‖ 密文」得到的就是规范要的
        // seq || packet_length || encrypted_packet。
        const macBytes = mac ? await mac(concat(lengthField, encryptedBody), seqNum) : null;

        const result = new Uint8Array(4 + encryptedBody.length + (macBytes ? macBytes.length : 0));
        result.set(lengthField, 0);
        result.set(encryptedBody, 4);
        if (macBytes) result.set(macBytes, 4 + encryptedBody.length);
        return result;
      }
      if (aead) {
        const lengthField = packet.subarray(0, 4);
        const dataToEncrypt = packet.subarray(4);
        const encryptedData = await encrypt(dataToEncrypt, seqNum, lengthField);
        const result = new Uint8Array(4 + encryptedData.length);
        result.set(lengthField, 0);
        result.set(encryptedData, 4);
        return result;
      }
      const encryptedPacket = await encrypt(packet, seqNum);
      if (mac) {
        const macBytes = await mac(packet, seqNum);
        const result = new Uint8Array(encryptedPacket.length + macBytes.length);
        result.set(encryptedPacket, 0);
        result.set(macBytes, encryptedPacket.length);
        return result;
      }
      return encryptedPacket;
    }

    return packet;
  }
}
