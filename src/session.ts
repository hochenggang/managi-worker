// 一条 SSH 连接，说 managi 的协议。
//
// 分两层：
//   · ssh/ 下的协议栈（KEX / 认证 / 报文 / 通道 / SFTP）来自 EdgeSSH，逐字保留；
//   · 本文件负责握手编排、通道生命周期，以及把结果翻译成 managi 的控制帧与数据帧。
//
// 与 Go 版的一处刻意简化：这里**一路通道一条 SSH 连接**，不做连接池复用。
// 每路标签彼此完全隔离，一条挂死的通道不会牵动别的；代价是同主机的多个标签
// 会各做一次握手（见 README「与 Go 版的差异」）。

import {
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_EXTENDED_DATA,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_REQUEST,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_DEBUG,
  SSH_MSG_DISCONNECT,
  SSH_MSG_EXT_INFO,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_IGNORE,
  SSH_MSG_KEXINIT,
  SSH_MSG_KEX_ECDH_REPLY,
  SSH_MSG_NEWKEYS,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_REQUEST_SUCCESS,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_UNIMPLEMENTED,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_INFO_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
  type SSHConnectionConfig,
  type SSHPacket,
  type SessionKeys,
} from './types';
import { isSSH2Identification, SSHTransport } from './ssh/transport';
import { SSHPacketBuilder, SSHPacketParser, nextSequenceNumber } from './ssh/packet';
import { KEXInitBuilder, filterExtInfo, negotiate, parseKEXInit, parseServerSigAlgs } from './ssh/kex';
import {
  KEX_ALGORITHM_ECDH_NISTP256,
  getCipherSpec,
  getMacSpec,
  isCurve25519KEXAlgorithm,
  isEtmMacAlgorithm,
} from './ssh/algorithms';
import { ECDHKeyExchange } from './ssh/kex-ecdh';
import { Curve25519KeyExchange, type Curve25519KeyPair } from './ssh/kex-curve25519';
import { KeyDerivation } from './ssh/keys';
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from './ssh/crypto';
import { SSHAuth } from './ssh/auth';
import { SSHChannel, type ChannelDataChunk } from './ssh/channel';
import { SFTPClient, SFTP_OPEN_FLAGS, type SFTPAttrs } from './ssh/sftp';
import { encodeString, readUint32, toBufferSource, writeUint32 } from './ssh/utils';
import { messageOf, toError } from './util';
import {
  isDirectory,
  joinPath,
  partFilePath,
  isIdentityPart,
  sizeOf,
  toFileItem,
  type FileItemOut,
} from './file-meta';

type Cipher = SSHAESGCMCipher | SSHAESCTRCipher;

/** 凭据或主机信任已被拒绝：重试没有意义，还可能触发远端账户锁定。 */
export class SSHAuthDefectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSHAuthDefectError';
  }
}

/**
 * describeConnectFailure 给一次建连/握手失败配上「哪个节点、为什么」，直接给用户看。
 * 三个调用方（WS open / 批量命令 / 下载）共用，文案才不会一处一个样。
 */
export function describeConnectFailure(error: unknown, host: string, port: number): string {
  const message = messageOf(error);
  // 凭据 / 主机信任被拒：原因本身已经说清楚了，再补东西只会误导。
  if (error instanceof SSHAuthDefectError) return message;
  // 私钥格式提示只在「确实是私钥本身有问题」时补。认证失败的文案里也含「私钥」二字
  // （"用户名、密码或私钥不正确"），照着关键词补一句「只支持未加密 OpenSSH 私钥」
  // 会把用密码的人往错方向带。
  if (/private key|私钥/i.test(message) && !/认证|密码|password|auth/i.test(message)) {
    return `${message}（仅支持未加密的 OpenSSH 格式私钥）`;
  }
  return `${host.trim()}:${port} — ${message}`;
}

/**
 * 协商 MAC。
 *
 * AEAD 密码（aes*-gcm）自带完整性保护，此时按规范**必须跳过** MAC 协商：
 * draft-miller-sshm-aes-gcm §2 —— 两端谈成 AEAD 后，「MAC 列表无交集」不得导致连接失败。
 * 上游 EdgeSSH 是无条件协商的（它那里有条注释自陈理由，说 RFC 4253 要求协商 MAC ——
 * 依据是过时版本；RFC 5647 的那条规则正被该草案修正），于是「服务器给 aes*-gcm、
 * 但它的 MAC 列表与我们不相交」会**假失败**：明明能连，却报 No common MAC。
 *
 * 这是严格的扩集：只在「已选 AEAD 且 MAC 无交集」这一种情况下，把结果从抛错改成连通。
 * AEAD 路径本来就把 MAC 置 'none'，密钥派生长度与 signer/verifier 的创建条件都不变，
 * 所以对已经能连的服务器零影响。
 */
export function negotiateMac(
  clientList: string[],
  serverList: string[],
  label: string,
  cipher: string,
): string {
  if (getCipherSpec(cipher).aead) return 'none';
  try {
    return negotiate(clientList, serverList, label);
  } catch (error) {
    // 非 AEAD 时 MAC 确实必须协商成功。补上已选加密算法，否则只看这条报文分不清
    // 「服务器没给出可用 MAC」和「它的 MAC 是给 AEAD 之外的东西配的」。
    throw new Error(`${messageOf(error)}（加密算法已选 ${cipher}，不是 AEAD，MAC 必须协商成功）`);
  }
}

/** 一路通道对外的三个出口 + 两个生命周期通知。 */
export interface ChannelCallbacks {
  /** 通道上的字节，要发给浏览器。end=true 表示这路流到此结束。 */
  data(payload: Uint8Array, end?: boolean): void;
  /** 服务端主动推的控制帧（目前只有 ack）。 */
  control(envelope: { type: string; data?: unknown }): void;
  /** 通道级错误。 */
  error(message: string): void;
  /** 通道就绪：PTY 是 shell 起来，SFTP 是子系统就绪（info 为 home）。 */
  ready(info?: string): void;
  /** 通道开不起来（服务器拒绝、握手失败）。 */
  failed(message: string): void;
}

export interface ConnectionHooks {
  /** 连接彻底结束（认证失败、远端断开、保活超时）。
   *  传 Error 而不是字符串：调用方要能分辨「凭据/信任被拒」这类不该重试的缺陷。 */
  ended(error: Error): void;
  /** 主机密钥校验；返回 ok=false 时连接被拒绝。 */
  verifyHostKey(fingerprint: string): Promise<{ ok: boolean; reason?: string }>;
}

/** 通道能力：SSH 连接把报文事件投给它，它决定这条通道干什么。 */
interface ChannelHandler {
  onOpened(channel: SSHChannel): void | Promise<void>;
  onRequestResult(success: boolean): void | Promise<void>;
  onData(chunk: Uint8Array): void;
  onExtendedData(chunk: Uint8Array): void;
  onEof(): void;
  onClose(): void;
  onWindowAdjust(): void;
  onExitStatus(status: number): void;
  onOpenFailure(message: string): void;
}

const LOCAL_WINDOW_THRESHOLD = 512 * 1024;
const MAX_VERSION_BYTES = 8192;
const KEEPALIVE_NAME = new TextEncoder().encode('keepalive@openssh.com');
const KEEPALIVE_INTERVAL_MS = 25_000;
const KEEPALIVE_MAX_MISSES = 3;

export class SSHConnection {
  private readonly socket: Socket;
  private readonly config: SSHConnectionConfig;
  private readonly hooks: ConnectionHooks;
  private readonly decoder = new TextDecoder();

  private readonly transport = new SSHTransport();
  private readonly parser = new SSHPacketParser();
  private readonly channels = new Map<number, { channel: SSHChannel; handler: ChannelHandler }>();

  private phase: 'version' | 'kex' | 'auth' | 'ready' | 'closed' = 'version';
  private versionBuffer = new Uint8Array();
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private sendSequence = 0;
  private sendChain: Promise<void> = Promise.resolve();

  private localKex: Uint8Array | null = null;
  private remoteKex: Uint8Array | null = null;
  private kexName: string | null = null;
  private hostKeyAlgorithm: string | null = null;
  private ecdhPair: CryptoKeyPair | null = null;
  private curvePair: Curve25519KeyPair | null = null;
  private clientPublic: Uint8Array | null = null;
  private sessionId: Uint8Array | null = null;
  private keys: SessionKeys | null = null;
  private cipherC2S = 'aes128-gcm@openssh.com';
  private cipherS2C = 'aes128-gcm@openssh.com';
  private macC2S = 'none';
  private macS2C = 'none';
  private encryptor: Cipher | null = null;
  private decryptor: Cipher | null = null;
  private signer: SSHHMAC | null = null;
  private verifier: SSHHMAC | null = null;

  private serverSigAlgs: string[] = [];
  private authRequestSent = false;
  private passwordAuthMethod: 'password' | 'keyboard-interactive' = 'password';
  private keyboardInteractiveRounds = 0;
  private keyboardInteractivePasswordSent = false;

  private nextChannelID = 1;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepalivePending = 0;
  private ignoreNextKexPacket = false;

  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readonly ready: Promise<void>;

  constructor(socket: Socket, config: SSHConnectionConfig, hooks: ConnectionHooks) {
    this.socket = socket;
    this.config = config;
    this.hooks = hooks;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 握手失败而调用方尚未 await 时，别让这条 rejection 变成未处理拒绝。
    this.ready.catch(() => undefined);
  }

  /** handshake 走完版本交换 + 密钥协商 + 认证，成功即 phase='ready'。 */
  async handshake(): Promise<void> {
    await this.write(this.transport.getLocalIdentification());
    void this.readLoop();
    await this.ready;
  }

  isReady(): boolean {
    return this.phase === 'ready';
  }

  // ===== 对外通道 API =====

  openPTY(handler: PTYHandler): number {
    this.assertReady();
    return this.openChannel(handler);
  }

  openSFTP(handler: SFTPHandler): number {
    this.assertReady();
    return this.openChannel(handler);
  }

  openExec(handler: ExecHandler): number {
    this.assertReady();
    return this.openChannel(handler);
  }

  resizePTY(localChannelID: number, cols: number, rows: number): void {
    const entry = this.channels.get(localChannelID);
    if (!entry || this.phase !== 'ready') return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 1000 || rows < 5 || rows > 1000) return;
    if (!entry.channel.isOpen()) return;
    void this.sendEncrypted(entry.channel.buildWindowChange(cols, rows)).catch(() => undefined);
  }

  closeChannel(localChannelID: number): void {
    const entry = this.channels.get(localChannelID);
    if (!entry) return;
    this.channels.delete(localChannelID);
    // 一路通道一条连接：通道关掉，连接也该跟着关。
    this.close();
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    for (const entry of [...this.channels.values()]) entry.handler.onClose();
    this.channels.clear();
    this.clearCredentials();
    try { this.writer?.releaseLock(); } catch { /* 已释放 */ }
    this.writer = null;
    try { this.socket.close(); } catch { /* 已关闭 */ }
    this.failReady(new Error('连接已关闭'));
  }

  // ===== 握手 =====

  private async readLoop(): Promise<void> {
    const reader = this.socket.readable.getReader();
    try {
      while (this.phase !== 'closed') {
        const { value, done } = await reader.read();
        if (done) {
          this.fail('SSH 服务器关闭了连接');
          return;
        }
        if (value && value.length > 0) await this.consume(value);
      }
    } catch (error) {
      this.abort(toError(error));
    } finally {
      try { reader.releaseLock(); } catch { /* 忽略 */ }
    }
  }

  private async consume(data: Uint8Array): Promise<void> {
    if (this.phase === 'version') {
      const merged = new Uint8Array(this.versionBuffer.length + data.length);
      merged.set(this.versionBuffer);
      merged.set(data, this.versionBuffer.length);
      if (merged.length > MAX_VERSION_BYTES) throw new Error('SSH 版本标识过长');
      this.versionBuffer = merged;
      let start = 0;
      for (;;) {
        const newline = this.versionBuffer.indexOf(0x0a, start);
        if (newline < 0) return;
        const bytes = this.versionBuffer.subarray(start, newline + 1);
        start = newline + 1;
        const line = this.decoder.decode(bytes).replace(/\r?\n$/, '');
        if (!line.startsWith('SSH-')) continue;
        if (!isSSH2Identification(line)) throw new Error('对端不支持 SSH 2.0');
        this.transport.setRemoteVersion(line);
        const remaining = this.versionBuffer.subarray(start);
        this.versionBuffer = new Uint8Array();
        this.phase = 'kex';
        await this.startKex();
        if (remaining.length > 0) {
          this.parser.feed(remaining);
          await this.processPackets();
        }
        return;
      }
    }
    this.parser.feed(data);
    await this.processPackets();
  }

  private async startKex(): Promise<void> {
    this.localKex = KEXInitBuilder.build();
    await this.sendPlain(this.localKex);
  }

  private async processPackets(): Promise<void> {
    while (this.phase !== 'closed') {
      // NEWKEYS 可能在同一批 TCP 字节里同时开启入站加密，故每轮重新算分帧参数。
      const spec = this.decryptor ? getCipherSpec(this.cipherS2C) : null;
      const macLength = this.decryptor && !spec?.aead ? getMacSpec(this.macS2C).length : 0;
      const packet = await this.parser.nextPacket(
        spec?.blockSize ?? 8,
        this.decryptor ? (d, sequence, aad, commit) => this.decryptor!.decrypt(d, sequence, aad, commit) : (d) => d,
        Boolean(spec?.aead),
        macLength,
        this.verifier ? (d, mac, sequence) => this.verifier!.verify(d, sequence, mac) : undefined,
        spec !== null && isEtmMacAlgorithm(this.macS2C),
      );
      if (!packet) return;
      await this.handlePacket(packet);
    }
  }

  private async handlePacket(packet: SSHPacket): Promise<void> {
    const type = packet.payload[0];
    if (type === SSH_MSG_DISCONNECT) {
      this.fail('SSH 服务器主动断开');
      return;
    }
    if (type === SSH_MSG_IGNORE) return;
    if (type === SSH_MSG_DEBUG) return;
    if (type === SSH_MSG_UNIMPLEMENTED) return;
    if (type === SSH_MSG_GLOBAL_REQUEST) {
      await this.handleGlobalRequest(packet.payload);
      return;
    }
    if (type === SSH_MSG_REQUEST_SUCCESS || type === SSH_MSG_REQUEST_FAILURE) {
      this.keepalivePending = 0;
      return;
    }
    if (type === SSH_MSG_KEXINIT && this.phase !== 'kex') {
      throw new Error('不支持服务器主动发起的 SSH 重新协商密钥');
    }
    if (this.phase === 'kex') { await this.handleKex(type, packet.payload); return; }
    if (this.phase === 'auth') { await this.handleAuth(type, packet.payload); return; }
    if (this.phase === 'ready') { await this.handleChannel(type, packet.payload); }
  }

  private async handleKex(type: number, payload: Uint8Array): Promise<void> {
    if (this.ignoreNextKexPacket) {
      this.ignoreNextKexPacket = false;
      return;
    }
    if (type === SSH_MSG_KEXINIT) {
      this.remoteKex = payload;
      const client = parseKEXInit(this.localKex!);
      const server = parseKEXInit(payload);
      this.kexName = negotiate(filterExtInfo(client.kexAlgorithms), filterExtInfo(server.kexAlgorithms), '密钥交换算法');
      this.hostKeyAlgorithm = negotiate(client.hostKeyAlgorithms, server.hostKeyAlgorithms, '主机密钥算法');
      this.ignoreNextKexPacket = server.firstKexPacketFollows
        && (filterExtInfo(server.kexAlgorithms)[0] !== this.kexName || server.hostKeyAlgorithms[0] !== this.hostKeyAlgorithm);
      this.cipherC2S = negotiate(client.encryptionC2S, server.encryptionC2S, '客户端加密算法');
      this.cipherS2C = negotiate(client.encryptionS2C, server.encryptionS2C, '服务端加密算法');
      this.macC2S = negotiateMac(client.macC2S, server.macC2S, '客户端 MAC', this.cipherC2S);
      this.macS2C = negotiateMac(client.macS2C, server.macS2C, '服务端 MAC', this.cipherS2C);
      if (negotiate(client.compressionC2S, server.compressionC2S, '客户端压缩') !== 'none'
        || negotiate(client.compressionS2C, server.compressionS2C, '服务端压缩') !== 'none') {
        throw new Error('不支持 SSH 压缩');
      }
      await this.sendKexInit();
      return;
    }
    if (type === SSH_MSG_KEX_ECDH_REPLY) {
      await this.handleEcdhReply(payload);
      return;
    }
    if (type === SSH_MSG_NEWKEYS) {
      if (!this.keys || !this.encryptor) throw new Error('NEWKEYS 早于密钥协商完成');
      await this.enableInboundEncryption();
      this.phase = 'auth';
      await this.sendEncrypted(new Uint8Array([SSH_MSG_SERVICE_REQUEST, ...encodeString('ssh-userauth')]));
    }
  }

  private async sendKexInit(): Promise<void> {
    if (this.kexName && isCurve25519KEXAlgorithm(this.kexName)) {
      this.curvePair = await Curve25519KeyExchange.generateKeyPair();
      this.clientPublic = await Curve25519KeyExchange.exportRawPublicKey(this.curvePair);
      await this.sendPlain(Curve25519KeyExchange.buildInit(this.clientPublic));
      return;
    }
    if (this.kexName === KEX_ALGORITHM_ECDH_NISTP256) {
      this.ecdhPair = await ECDHKeyExchange.generateKeyPair();
      this.clientPublic = await ECDHKeyExchange.exportRawPublicKey(this.ecdhPair);
      await this.sendPlain(ECDHKeyExchange.buildInit(this.clientPublic));
      return;
    }
    throw new Error(`不支持的密钥交换算法：${this.kexName ?? 'none'}`);
  }

  private async handleEcdhReply(payload: Uint8Array): Promise<void> {
    if (!this.kexName || !this.clientPublic || !this.localKex || !this.remoteKex) {
      throw new Error('收到意外的密钥交换应答');
    }
    const { hostKey, serverRawPublicKey, signature } = ECDHKeyExchange.parseReply(payload);
    let sharedSecret: Uint8Array;
    let hash: Uint8Array;
    if (isCurve25519KEXAlgorithm(this.kexName)) {
      if (!this.curvePair) throw new Error('缺少 Curve25519 密钥');
      sharedSecret = await Curve25519KeyExchange.computeSharedSecret(this.curvePair.privateKey, serverRawPublicKey);
      hash = await Curve25519KeyExchange.computeExchangeHash(
        this.transport.getLocalVersion(), this.transport.getRemoteVersion(),
        this.localKex, this.remoteKex, hostKey, this.clientPublic, serverRawPublicKey, sharedSecret,
      );
    } else {
      if (!this.ecdhPair) throw new Error('缺少 ECDH 密钥');
      sharedSecret = await ECDHKeyExchange.computeSharedSecret(this.ecdhPair.privateKey, serverRawPublicKey);
      hash = await ECDHKeyExchange.computeExchangeHash(
        this.transport.getLocalVersion(), this.transport.getRemoteVersion(),
        this.localKex, this.remoteKex, hostKey, this.clientPublic, serverRawPublicKey, sharedSecret,
      );
    }
    const keyTypeLength = readUint32(hostKey, 0);
    if (keyTypeLength > 128 || keyTypeLength + 4 > hostKey.length) throw new Error('主机密钥格式错误');
    const keyType = this.decoder.decode(hostKey.subarray(4, 4 + keyTypeLength));
    if (!this.isHostKeyAlgorithmCompatible(this.hostKeyAlgorithm, keyType)) {
      throw new Error(`服务器用了 ${keyType}，但协商结果是 ${this.hostKeyAlgorithm ?? '无'}`);
    }
    const fingerprint = `SHA256:${this.base64(new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(hostKey))))}`;
    if (!await this.verifyHostSignature(hostKey, signature, hash)) {
      throw new SSHAuthDefectError('SSH 主机密钥签名校验失败');
    }
    const trust = await this.hooks.verifyHostKey(fingerprint);
    if (!trust.ok) throw new SSHAuthDefectError(trust.reason ?? '主机密钥未被接受');

    this.sessionId ??= hash;
    const c2s = getCipherSpec(this.cipherC2S);
    const s2c = getCipherSpec(this.cipherS2C);
    this.keys = await KeyDerivation.deriveKeys(
      sharedSecret, hash, this.sessionId,
      c2s.ivLength, s2c.ivLength,
      getMacSpec(this.macC2S).keyLength, getMacSpec(this.macS2C).keyLength,
      c2s.keyLength, s2c.keyLength,
    );
    await this.sendPlain(new Uint8Array([SSH_MSG_NEWKEYS]));
    await this.enableOutboundEncryption();
  }

  private async verifyHostSignature(hostKey: Uint8Array, signature: Uint8Array, hash: Uint8Array): Promise<boolean> {
    let offset = 0;
    const keyType = this.readString(hostKey, offset); offset = keyType.next;
    let sigOffset = 0;
    const signatureType = this.readString(signature, sigOffset); sigOffset = signatureType.next;
    const signatureField = this.readBytes(signature, sigOffset);
    if (signatureField.next !== signature.length) throw new Error('主机签名格式错误');
    const rawSignature = signatureField.value;
    if (keyType.value === 'ssh-ed25519') {
      if (this.hostKeyAlgorithm !== 'ssh-ed25519' || signatureType.value !== 'ssh-ed25519') {
        throw new Error('Ed25519 主机密钥与协商算法不符');
      }
      const keyField = this.readBytes(hostKey, offset);
      if (keyField.next !== hostKey.length || keyField.value.length !== 32 || rawSignature.length !== 64) {
        throw new Error('Ed25519 主机密钥格式错误');
      }
      const key = await crypto.subtle.importKey('raw', toBufferSource(keyField.value), { name: 'Ed25519' }, false, ['verify']);
      return crypto.subtle.verify('Ed25519', key, toBufferSource(rawSignature), toBufferSource(hash));
    }
    if (keyType.value.startsWith('ecdsa-sha2-nistp')) {
      if (this.hostKeyAlgorithm !== keyType.value || signatureType.value !== keyType.value) {
        throw new Error('ECDSA 主机密钥与协商算法不符');
      }
      const curveName = this.readString(hostKey, offset); offset = curveName.next;
      const keyField = this.readBytes(hostKey, offset);
      if (keyField.next !== hostKey.length) throw new Error('ECDSA 主机密钥格式错误');
      const curve = keyType.value.endsWith('256') ? 'P-256' : keyType.value.endsWith('384') ? 'P-384' : 'P-521';
      if (curveName.value !== keyType.value.replace('ecdsa-sha2-', '')) throw new Error('ECDSA 曲线名与主机密钥类型不符');
      const digest = curve === 'P-256' ? 'SHA-256' : curve === 'P-384' ? 'SHA-384' : 'SHA-512';
      const coordinateBytes = curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66;
      const key = await crypto.subtle.importKey('raw', toBufferSource(keyField.value), { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: digest },
        key,
        toBufferSource(this.sshEcdsaToRaw(rawSignature, coordinateBytes)),
        toBufferSource(hash),
      );
    }
    if (keyType.value === 'ssh-rsa') {
      if (signatureType.value !== 'rsa-sha2-256' && signatureType.value !== 'rsa-sha2-512') {
        throw new Error(`不支持的 RSA 主机签名类型：${signatureType.value}`);
      }
      if (signatureType.value !== this.hostKeyAlgorithm) throw new Error(`RSA 签名 ${signatureType.value} 与协商算法不符`);
      const exponent = this.readBytes(hostKey, offset); offset = exponent.next;
      const modulusField = this.readBytes(hostKey, offset);
      if (modulusField.next !== hostKey.length || exponent.value.length === 0 || modulusField.value.length === 0) {
        throw new Error('RSA 主机密钥格式错误');
      }
      const digest = signatureType.value === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256';
      const key = await crypto.subtle.importKey('jwk', {
        kty: 'RSA',
        e: this.base64UrlUnsigned(exponent.value),
        n: this.base64UrlUnsigned(modulusField.value),
        ext: true,
      }, { name: 'RSASSA-PKCS1-v1_5', hash: digest }, false, ['verify']);
      return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, toBufferSource(rawSignature), toBufferSource(hash));
    }
    throw new Error(`不支持的主机密钥类型：${keyType.value}`);
  }

  private async enableOutboundEncryption(): Promise<void> {
    if (!this.keys) throw new Error('会话密钥不可用');
    const c2s = getCipherSpec(this.cipherC2S);
    this.encryptor = c2s.mode === 'gcm'
      ? new SSHAESGCMCipher(this.keys.encKeyClientToServer.subarray(0, c2s.keyLength), this.keys.ivClientToServer)
      : new SSHAESCTRCipher(this.keys.encKeyClientToServer.subarray(0, c2s.keyLength), this.keys.ivClientToServer);
    await this.encryptor.init();
    if (!c2s.aead) {
      this.signer = new SSHHMAC(this.macC2S, this.keys.integrityKeyC2S);
      await this.signer.init();
    }
  }

  private async enableInboundEncryption(): Promise<void> {
    if (!this.keys) throw new Error('会话密钥不可用');
    const s2c = getCipherSpec(this.cipherS2C);
    this.decryptor = s2c.mode === 'gcm'
      ? new SSHAESGCMCipher(this.keys.encKeyServerToClient.subarray(0, s2c.keyLength), this.keys.ivServerToClient)
      : new SSHAESCTRCipher(this.keys.encKeyServerToClient.subarray(0, s2c.keyLength), this.keys.ivServerToClient);
    await this.decryptor.init();
    if (!s2c.aead) {
      this.verifier = new SSHHMAC(this.macS2C, this.keys.integrityKeyS2C);
      await this.verifier.init();
    }
  }

  private async handleAuth(type: number, payload: Uint8Array): Promise<void> {
    if (type === SSH_MSG_EXT_INFO) {
      if (this.authRequestSent) throw new Error('认证已开始，却又收到 SSH 扩展信息');
      this.serverSigAlgs = parseServerSigAlgs(payload);
      return;
    }
    if (type === SSH_MSG_SERVICE_ACCEPT) {
      const service = this.readString(payload, 1);
      if (service.next !== payload.length || service.value !== 'ssh-userauth') throw new Error('SSH 认证服务应答非法');
      if (this.authRequestSent) throw new Error('重复的 SSH 认证服务应答');
      const request = this.config.authMethod === 'publickey'
        ? await SSHAuth.buildPublicKeyAuthRequest(this.config.username, this.config.privateKey!, this.sessionId!, this.serverSigAlgs)
        : SSHAuth.buildPasswordAuthRequest(this.config.username, this.config.password!);
      this.authRequestSent = true;
      if (this.config.authMethod === 'publickey') this.config.privateKey = undefined;
      await this.sendEncrypted(request);
      return;
    }
    if (type === SSH_MSG_USERAUTH_INFO_REQUEST) {
      if (this.config.authMethod !== 'password' || this.passwordAuthMethod !== 'keyboard-interactive' || !this.authRequestSent) {
        throw new Error('意外的 SSH keyboard-interactive 挑战');
      }
      this.keyboardInteractiveRounds++;
      if (this.keyboardInteractiveRounds > 16) throw new Error('SSH keyboard-interactive 挑战轮次过多');
      const challenge = SSHAuth.parseKeyboardInteractiveChallenge(payload);
      let responses: string[];
      if (challenge.prompts.length === 0) {
        responses = [];
      } else {
        if (this.keyboardInteractivePasswordSent || this.config.password === undefined) {
          throw new Error('SSH keyboard-interactive 重复索要凭据');
        }
        responses = SSHAuth.passwordResponsesForChallenge(challenge, this.config.password, {
          username: this.config.username,
          host: this.config.host,
        });
      }
      if (responses.length > 0) {
        this.keyboardInteractivePasswordSent = true;
        this.config.password = undefined;
      }
      await this.sendEncrypted(SSHAuth.buildKeyboardInteractiveResponse(responses));
      return;
    }
    if (type === SSH_MSG_USERAUTH_SUCCESS) {
      if (payload.length !== 1) throw new Error('SSH 认证成功报文格式错误');
      if (!this.authRequestSent) throw new Error('在发送凭据之前就认证成功了');
      this.clearCredentials();
      this.phase = 'ready';
      this.startKeepalive();
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (type === SSH_MSG_USERAUTH_FAILURE) {
      if (!this.authRequestSent) throw new Error('在发送凭据之前就认证失败了');
      const methods = this.validateAuthFailure(payload);
      if (this.config.authMethod === 'password'
        && this.passwordAuthMethod === 'password'
        && this.config.password !== undefined
        && methods.includes('keyboard-interactive')) {
        this.passwordAuthMethod = 'keyboard-interactive';
        await this.sendEncrypted(SSHAuth.buildKeyboardInteractiveAuthRequest(this.config.username));
        return;
      }
      this.clearCredentials();
      throw new SSHAuthDefectError('SSH 认证失败：用户名、密码或私钥不正确');
    }
  }

  // ===== 通道 =====

  private assertReady(): void {
    if (this.phase !== 'ready') throw new Error('SSH 连接尚未就绪');
  }

  private openChannel(handler: ChannelHandler): number {
    const channel = new SSHChannel();
    const payload = channel.buildOpenSession(this.nextChannelID++);
    const localChannelID = channel.getLocalChannelID();
    this.channels.set(localChannelID, { channel, handler });
    void this.sendEncrypted(payload).catch((error) => {
      this.channels.delete(localChannelID);
      handler.onOpenFailure(messageOf(error));
    });
    return localChannelID;
  }

  private async handleChannel(type: number, payload: Uint8Array): Promise<void> {
    if (payload.length < 5) throw new Error('SSH 通道报文格式错误');
    const localChannelID = readUint32(payload, 1);
    const entry = this.channels.get(localChannelID);
    if (!entry) throw new Error('SSH 通道报文指向了未知通道');
    const { channel, handler } = entry;

    if (type === SSH_MSG_CHANNEL_OPEN_CONFIRMATION) {
      channel.handleOpenConfirmation(payload);
      await handler.onOpened(channel);
      return;
    }
    if (type === SSH_MSG_CHANNEL_OPEN_FAILURE) {
      channel.handleOpenFailure(payload);
      this.channels.delete(localChannelID);
      handler.onOpenFailure('SSH 服务器拒绝打开通道');
      return;
    }
    if (type === SSH_MSG_CHANNEL_SUCCESS || type === SSH_MSG_CHANNEL_FAILURE) {
      channel.handleRequestResult(payload);
      await handler.onRequestResult(type === SSH_MSG_CHANNEL_SUCCESS);
      return;
    }
    if (type === SSH_MSG_CHANNEL_REQUEST) {
      // 服务端发来的通道请求：只认 exec 的 exit-status，其余按「不支持」回失败。
      const name = this.readString(payload, 5);
      const wantReply = payload[name.next];
      if (name.value === 'exit-status' && name.next + 5 <= payload.length) {
        handler.onExitStatus(readUint32(payload, name.next + 1));
      }
      if (wantReply === 1 && channel.isOpen()) {
        const failure = new Uint8Array(5);
        failure[0] = SSH_MSG_CHANNEL_FAILURE;
        writeUint32(failure, 1, channel.getLocalChannelID());
        await this.sendEncrypted(failure).catch(() => undefined);
      }
      return;
    }
    if (type === SSH_MSG_CHANNEL_DATA) {
      const chunk = channel.handleChannelData(payload);
      handler.onData(chunk);
      await this.adjustLocalWindow(channel);
      return;
    }
    if (type === SSH_MSG_CHANNEL_EXTENDED_DATA) {
      const chunk = channel.handleExtendedData(payload);
      handler.onExtendedData(chunk);
      await this.adjustLocalWindow(channel);
      return;
    }
    if (type === SSH_MSG_CHANNEL_WINDOW_ADJUST) {
      channel.handleWindowAdjust(payload);
      handler.onWindowAdjust();
      return;
    }
    if (type === SSH_MSG_CHANNEL_EOF) {
      channel.handleEof(payload);
      handler.onEof();
      return;
    }
    if (type === SSH_MSG_CHANNEL_CLOSE) {
      channel.handleClose(payload);
      if (!channel.hasSentClose()) await this.sendEncrypted(channel.buildClose()).catch(() => undefined);
      this.channels.delete(localChannelID);
      handler.onClose();
      return;
    }
  }

  private async adjustLocalWindow(channel: SSHChannel): Promise<void> {
    const amount = channel.takeLocalWindowAdjustment(LOCAL_WINDOW_THRESHOLD);
    if (amount !== null) await this.sendEncrypted(channel.buildWindowAdjust(amount));
  }

  /** sendChannelClose 收尾：EOF + CLOSE（幂等）。 */
  async sendChannelClose(channel: SSHChannel): Promise<void> {
    if (!channel.isOpen() || channel.hasSentClose()) return;
    try {
      await this.sendEncrypted(channel.buildEof());
      await this.sendEncrypted(channel.buildClose());
    } catch { /* 连接可能已经在关 */ }
  }

  /** sendChannelData 把一段通道数据写出去（调用方负责给出窗口内的一片）。 */
  async sendChannelData(channel: SSHChannel, chunk: ChannelDataChunk): Promise<void> {
    await this.serialSend(async () => {
      if (!this.encryptor) throw new Error('SSH 加密尚未初始化');
      const spec = getCipherSpec(this.cipherC2S);
      const packet = await SSHPacketBuilder.buildWithPayloadWriter(
        chunk.payloadLength,
        (target, offset) => channel.writeChannelDataPayload(target, offset, chunk.source, chunk.sourceOffset, chunk.bytesConsumed),
        spec.blockSize,
        (data, sequence, aad) => this.encryptor!.encrypt(data, sequence, aad),
        this.sendSequence,
        spec.aead,
        this.signer ? (data, sequence) => this.signer!.sign(data, sequence) : undefined,
        isEtmMacAlgorithm(this.macC2S),
      );
      this.sendSequence = nextSequenceNumber(this.sendSequence);
      await this.write(packet);
    });
  }

  // ===== 传输底层 =====

  private async handleGlobalRequest(payload: Uint8Array): Promise<void> {
    if (payload.length < 6) throw new Error('全局请求报文格式错误');
    const nameLength = readUint32(payload, 1);
    if (5 + nameLength >= payload.length) throw new Error('全局请求报文格式错误');
    const wantsReply = payload[5 + nameLength] === 1;
    if (wantsReply && this.encryptor) await this.sendEncrypted(new Uint8Array([SSH_MSG_REQUEST_FAILURE]));
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.phase !== 'ready') return;
      if (this.keepalivePending >= KEEPALIVE_MAX_MISSES) {
        this.fail('SSH 保活超时，连接已断开');
        return;
      }
      this.keepalivePending++;
      const payload = new Uint8Array(1 + 4 + KEEPALIVE_NAME.length + 1);
      payload[0] = SSH_MSG_GLOBAL_REQUEST;
      new DataView(payload.buffer).setUint32(1, KEEPALIVE_NAME.length, false);
      payload.set(KEEPALIVE_NAME, 5);
      payload[payload.length - 1] = 1;
      void this.sendEncrypted(payload).catch((error) => this.abort(toError(error)));
    }, KEEPALIVE_INTERVAL_MS);
  }

  private async sendPlain(payload: Uint8Array): Promise<void> {
    await this.serialSend(async () => {
      const packet = await SSHPacketBuilder.build(payload, 8, null, this.sendSequence);
      this.sendSequence = nextSequenceNumber(this.sendSequence);
      await this.write(packet);
    });
  }

  /** sendEncrypted 发一个加密报文；通道处理器用它发通道请求。 */
  async sendEncrypted(payload: Uint8Array): Promise<void> {
    await this.serialSend(async () => {
      if (!this.encryptor) throw new Error('SSH 加密尚未初始化');
      const spec = getCipherSpec(this.cipherC2S);
      const packet = await SSHPacketBuilder.build(
        payload, spec.blockSize,
        (data, sequence, aad) => this.encryptor!.encrypt(data, sequence, aad),
        this.sendSequence, spec.aead,
        this.signer ? (data, sequence) => this.signer!.sign(data, sequence) : undefined,
        isEtmMacAlgorithm(this.macC2S),
      );
      this.sendSequence = nextSequenceNumber(this.sendSequence);
      await this.write(packet);
    });
  }

  private async serialSend(operation: () => Promise<void>): Promise<void> {
    const next = this.sendChain.then(operation);
    this.sendChain = next.catch(() => undefined);
    await next;
  }

  private async write(data: Uint8Array): Promise<void> {
    const writer = this.writer ?? this.socket.writable.getWriter();
    this.writer = writer;
    await writer.write(data);
  }

  private failReady(error: Error): void {
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.resolveReady = null;
  }

  private fail(message: string): void {
    this.abort(new Error(message));
  }

  /** abort 收尾一次连接。
   *  形参收 Error 而不是字符串是有意的：`SSHAuthDefectError` 这种「重试也没用」的类型
   *  必须在沿途保留，否则调用方只能靠猜错误文案来分辨，猜错的代价是给用户错误的提示。 */
  private abort(error: Error): void {
    if (this.phase === 'closed') return;
    const wasReady = this.phase === 'ready';
    if (!wasReady) this.failReady(error);
    this.close();
    this.hooks.ended(error);
  }

  private clearCredentials(): void {
    this.config.password = undefined;
    this.config.privateKey = undefined;
  }

  // ===== 解析小工具 =====

  private readBytes(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } {
    if (offset + 4 > bytes.length) throw new Error('SSH 字段格式错误');
    const length = readUint32(bytes, offset);
    if (length > bytes.length - offset - 4) throw new Error('SSH 字段格式错误');
    return { value: bytes.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
  }

  private readString(bytes: Uint8Array, offset: number): { value: string; next: number } {
    const field = this.readBytes(bytes, offset);
    try {
      return { value: new TextDecoder('utf-8', { fatal: true }).decode(field.value), next: field.next };
    } catch {
      throw new Error('SSH 文本字段格式错误');
    }
  }

  private sshEcdsaToRaw(signature: Uint8Array, coordinateBytes: number): Uint8Array {
    const rField = this.readBytes(signature, 0);
    const sField = this.readBytes(signature, rField.next);
    if (sField.next !== signature.length) throw new Error('ECDSA 签名有多余数据');
    const trim = (value: Uint8Array): Uint8Array => {
      if (value.length === 0 || (value[0] & 0x80) !== 0) throw new Error('ECDSA 签名整数必须为正');
      return value.length > 1 && value[0] === 0 ? value.subarray(1) : value;
    };
    const r = trim(rField.value);
    const s = trim(sField.value);
    if (r.length > coordinateBytes || s.length > coordinateBytes) throw new Error('ECDSA 签名非法');
    const result = new Uint8Array(coordinateBytes * 2);
    result.set(r, coordinateBytes - r.length);
    result.set(s, coordinateBytes * 2 - s.length);
    return result;
  }

  private base64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=+$/, '');
  }

  private base64UrlUnsigned(bytes: Uint8Array): string {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    return this.base64(bytes.subarray(start)).replace(/\+/g, '-').replace(/\//g, '_');
  }

  private validateAuthFailure(payload: Uint8Array): string[] {
    if (payload.length < 6) throw new Error('SSH 认证失败报文格式错误');
    const methodsLength = readUint32(payload, 1);
    if (methodsLength > payload.length - 6 || methodsLength + 6 !== payload.length) {
      throw new Error('SSH 认证失败报文格式错误');
    }
    const partialSuccess = payload[payload.length - 1];
    if (partialSuccess > 1) throw new Error('SSH 认证部分成功标志非法');
    if (partialSuccess === 1) throw new Error('不支持多因素 SSH 认证');
    const methods = this.decoder.decode(payload.subarray(5, 5 + methodsLength));
    return methods ? methods.split(',') : [];
  }

  private isHostKeyAlgorithmCompatible(negotiated: string | null, keyType: string): boolean {
    if (!negotiated) return false;
    if (negotiated === keyType) return true;
    return keyType === 'ssh-rsa' && (negotiated === 'rsa-sha2-256' || negotiated === 'rsa-sha2-512');
  }
}

// ===== PTY =====

/** PTYHandler 一路终端：输入入队、输出成帧、按消费进度回 ack 推进前端窗口。 */
export class PTYHandler implements ChannelHandler {
  static readonly OUT_FRAME = 32 * 1024;
  /** 客户端 → 服务端单帧上限，随 open 响应下发，前端据此切粘贴分片。 */
  static readonly IN_FRAME = 32 * 1024;
  /** 输入窗口：前端未确认字节超过它就停下等待 ack。 */
  static readonly WINDOW = 256 * 1024;

  private channel: SSHChannel | null = null;
  private readonly queue: Uint8Array[] = [];
  private headOffset = 0;
  private flushing = false;
  private closed = false;
  private shellRequested = false;
  private readySent = false;
  private released = 0;

  constructor(
    private readonly conn: SSHConnection,
    private readonly cols: number,
    private readonly rows: number,
    private readonly cb: ChannelCallbacks,
  ) {}

  async onOpened(channel: SSHChannel): Promise<void> {
    this.channel = channel;
    await this.conn.sendEncrypted(channel.buildPTYRequest(this.cols, this.rows, 'xterm-256color'));
  }

  async onRequestResult(success: boolean): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    if (!this.shellRequested) {
      if (!success) {
        // 一路通道一条连接：PTY 起不来，这条连接就没有意义了。
        this.cb.failed('服务器拒绝了 PTY 请求');
        this.conn.close();
        return;
      }
      this.shellRequested = true;
      await this.conn.sendEncrypted(channel.buildShellRequest());
      return;
    }
    if (!success) {
      this.cb.failed('服务器拒绝了 shell 请求');
      return;
    }
    this.markReady();
  }

  private markReady(): void {
    if (this.readySent) return;
    this.readySent = true;
    this.cb.ready();
    void this.flush();
  }

  onData(chunk: Uint8Array): void {
    // 有些服务器不给 shell 请求回 CHANNEL_SUCCESS，首帧输出即代表 shell 起来了。
    this.markReady();
    for (let pos = 0; pos < chunk.length; pos += PTYHandler.OUT_FRAME) {
      this.cb.data(chunk.subarray(pos, pos + PTYHandler.OUT_FRAME));
    }
  }

  onExtendedData(chunk: Uint8Array): void {
    // PTY 下 stderr 通常已并进 pty；真收到也照样喂给终端，总比丢掉强。
    this.onData(chunk);
  }

  onEof(): void {
    this.markReady();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.cb.data(new Uint8Array(0), true);
  }

  onOpenFailure(message: string): void {
    this.cb.failed(message);
  }

  onExitStatus(): void {
    // 终端场景用不到退出码；通道关闭时前端会看到「会话已结束」。
  }

  onWindowAdjust(): void {
    void this.flush();
  }

  /** queueInput 收下前端的一片输入；由上层保证调用顺序。 */
  queueInput(payload: Uint8Array): void {
    if (this.closed || payload.length === 0) return;
    this.queue.push(payload);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const channel = this.channel;
        if (!channel) return;
        const first = this.queue[0];
        const chunk = channel.takeChannelDataChunk(first, this.headOffset);
        if (!chunk) return; // 等下一次 WINDOW_ADJUST
        await this.conn.sendChannelData(channel, chunk);
        this.headOffset += chunk.bytesConsumed;
        this.ack(chunk.bytesConsumed);
        if (this.headOffset === first.length) {
          this.queue.shift();
          this.headOffset = 0;
        }
      }
    } catch (error) {
      this.cb.error(messageOf(error));
    } finally {
      this.flushing = false;
    }
  }

  private ack(bytes: number): void {
    this.released += bytes;
    this.cb.control({ type: 'ack', data: { bytes: this.released } });
  }
}

// ===== SFTP =====

/** SFTPHandler 一路文件管理：目录操作走控制面，字节走数据面。 */
export class SFTPHandler implements ChannelHandler {
  /** 上传/下载的单片大小，也是上传时下发给前端的 chunk_size。 */
  static readonly CHUNK_SIZE = 64 * 1024;
  /** 上传方向的输入窗口。 */
  static readonly WINDOW = 1024 * 1024;

  private channel: SSHChannel | null = null;
  private client: SFTPClient | null = null;
  private home = '/';
  private disposed = false;
  private subsystemRequested = false;

  /**
   * 出站队列：只走 **SFTP 协议包**（请求 / 应答往服务器去的那一半）。
   * 上传与下载的文件内容不经过这里 —— 上传直接写 file handle，下载直接交给上层回调。
   * 串成一条队列是为了保证报文按生成的先后写上通道，协议栈才不会收到错位的响应。
   */
  private readonly outQueue: Array<{ data: Uint8Array; end: boolean }> = [];
  private outOffset = 0;
  private flushing = false;
  private readonly outWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  private upload: UploadState | null = null;
  private released = 0;
  private downloading = false;

  constructor(
    private readonly conn: SSHConnection,
    private readonly cb: ChannelCallbacks,
  ) {}

  async onOpened(channel: SSHChannel): Promise<void> {
    this.channel = channel;
    await this.conn.sendEncrypted(channel.buildSubsystemRequest('sftp'));
  }

  async onRequestResult(success: boolean): Promise<void> {
    if (this.subsystemRequested) return;
    this.subsystemRequested = true;
    if (!success) {
      this.cb.failed('服务器拒绝了 SFTP 子系统');
      return;
    }
    const channel = this.channel;
    if (!channel) return;
    const client = new SFTPClient(
      // 返回 void：SFTP 协议包按队列串行发，错误统一从 hooks 报出，避免无声挂死。
      (packet) => { this.enqueueOut(packet).catch((error) => this.reportFailure(error)); },
      { maxPacketLength: 4 * 1024 * 1024 },
    );
    this.client = client;
    try {
      const info = await client.initialize();
      if (info.version !== 3) throw new Error(`不支持的 SFTP 版本 ${info.version}`);
      let home = '/';
      try {
        const resolved = await client.realpath('.');
        if (resolved) home = resolved;
      } catch { /* 取不到主目录就退回根，与 Go 版一致 */ }
      this.home = home;
      this.cb.ready(home);
    } catch (error) {
      this.cb.failed(messageOf(error));
      this.dispose();
    }
  }

  onData(chunk: Uint8Array): void {
    try {
      this.client?.feed(chunk);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  onExtendedData(chunk: Uint8Array): void {
    const message = new TextDecoder().decode(chunk).trim();
    if (message) this.cb.error(message.slice(0, 512));
  }

  onEof(): void { /* sftp 子系统正常结束走 onClose */ }

  onClose(): void {
    this.dispose();
    this.cb.data(new Uint8Array(0), true);
  }

  onOpenFailure(message: string): void {
    this.cb.failed(message);
  }

  onExitStatus(): void { /* sftp 子系统没有退出码 */ }

  onWindowAdjust(): void {
    void this.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortUpload();
    this.outQueue.length = 0;
    this.outOffset = 0;
    for (const waiter of this.outWaiters.splice(0)) waiter.resolve();
    try { this.client?.dispose(); } catch { /* 已销毁 */ }
    this.client = null;
  }

  private reportFailure(error: unknown): void {
    const message = messageOf(error);
    this.cb.error(message);
    this.dispose();
  }

  // ===== 目录操作 =====

  async list(path: string): Promise<{ path: string; files: FileItemOut[] }> {
    const client = this.requireClient();
    if (!path) throw new Error('路径不能为空');
    const resolved = await this.realpathSafe(client, path);
    const handle = await client.openDir(resolved);
    const files: FileItemOut[] = [];
    try {
      for (;;) {
        const batch = await client.readDir(handle);
        if (!batch || batch.length === 0) break;
        for (const entry of batch) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          files.push(toFileItem(entry.filename, entry.attrs));
        }
      }
    } finally {
      await client.closeHandle(handle).catch(() => undefined);
    }
    return { path: resolved, files };
  }

  async mkdir(path: string): Promise<void> {
    const client = this.requireClient();
    if (!path) throw new Error('mkdir: path 必填');
    const absolute = path.startsWith('/');
    const parts = path.split('/').filter(Boolean);
    if (!absolute) {
      if (await this.pathIsDirectory(path)) return;
      await client.mkdir(path);
      return;
    }
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      if (await this.pathIsDirectory(current)) continue;
      await client.mkdir(current);
    }
  }

  /** remove 删除文件或目录（目录递归）。先 lstat，软链接只删链接本身。 */
  async remove(path: string): Promise<void> {
    const client = this.requireClient();
    if (!path) throw new Error('rm: path 必填');
    const attrs = await client.lstat(path).catch(() => client.stat(path));
    if (!isDirectory(attrs)) {
      await client.removeFile(path);
      return;
    }
    await this.removeDirectory(client, path);
  }

  private async removeDirectory(client: SFTPClient, path: string): Promise<void> {
    const entries = await this.readDirectory(client, path);
    for (const entry of entries) {
      const child = joinPath(path, entry.filename);
      if (isDirectory(entry.attrs)) await this.removeDirectory(client, child);
      else await client.removeFile(child);
    }
    await client.rmdir(path);
  }

  /** readDirectory 读出全部条目。READDIR 的属性是条目自身的属性（等同 lstat）。 */
  private async readDirectory(client: SFTPClient, path: string): Promise<{ filename: string; attrs: SFTPAttrs }[]> {
    const handle = await client.openDir(path);
    const entries: { filename: string; attrs: SFTPAttrs }[] = [];
    try {
      for (;;) {
        const batch = await client.readDir(handle);
        if (!batch || batch.length === 0) break;
        for (const entry of batch) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          entries.push({ filename: entry.filename, attrs: entry.attrs });
        }
      }
    } finally {
      await client.closeHandle(handle).catch(() => undefined);
    }
    return entries;
  }

  /** pathIsDirectory 探一个路径是不是目录；不存在或取不到属性都算「不是」。 */
  private async pathIsDirectory(path: string): Promise<boolean> {
    try {
      return isDirectory(await this.requireClient().stat(path));
    } catch {
      return false;
    }
  }

  private async realpathSafe(client: SFTPClient, path: string): Promise<string> {
    try {
      const resolved = await client.realpath(path);
      return resolved || path;
    } catch {
      return path;
    }
  }

  private requireClient(): SFTPClient {
    if (!this.client || this.disposed) throw new Error('SFTP 会话不可用');
    return this.client;
  }

  // ===== 上传：先写 .part，最后改名落定 =====

  async beginUpload(
    remoteDir: string,
    filename: string,
    size: number,
    mtime: number,
  ): Promise<{ offset: number; chunk_size: number }> {
    const client = this.requireClient();
    if (!filename || /[\\/]/.test(filename) || filename === '.' || filename === '..') {
      throw new Error(`非法文件名：${filename}`);
    }
    const dir = remoteDir || '.';
    const finalPath = joinPath(dir, filename);
    const partPath = partFilePath(finalPath, size, mtime);

    await this.mkdir(dir).catch(() => undefined);
    await this.cleanStaleParts(client, dir, filename, partPath);

    let offset = 0;
    const existing = await client.stat(partPath).catch(() => null);
    if (existing) {
      const existingSize = sizeOf(existing);
      if (existingSize !== null) {
        if (size > 0 && existingSize > size) {
          // 同身份却比声明还大：残片被外部动过，身份已不可信，丢弃重传。
          await client.removeFile(partPath).catch(() => undefined);
          offset = 0;
        } else {
          offset = existingSize;
        }
      }
    }

    this.abortUpload();
    const handle = await client.openFile(partPath, SFTP_OPEN_FLAGS.WRITE | SFTP_OPEN_FLAGS.CREATE);
    this.upload = { handle, partPath, finalPath, totalSize: size, offset };
    return { offset, chunk_size: SFTPHandler.CHUNK_SIZE };
  }

  /** writeData 落一片上传数据；由上层串行调用，帧序即文件序。 */
  async writeData(payload: Uint8Array): Promise<void> {
    const upload = this.upload;
    if (!upload) throw new Error('当前通道没有进行中的上传');
    const client = this.requireClient();
    if (upload.totalSize > 0 && upload.offset + payload.byteLength > upload.totalSize) {
      this.abortUpload();
      throw new Error(`分片超出声明的文件大小：${upload.offset} + ${payload.byteLength} > ${upload.totalSize}`);
    }
    try {
      await client.writeFile(upload.handle, upload.offset, payload);
    } catch (error) {
      this.abortUpload(); // .part 保留，重开通道即可续传
      throw error;
    }
    upload.offset += payload.byteLength;
    this.ack(payload.byteLength);
  }

  /** finishUpload 校验大小并改名，返回最终大小。 */
  async finishUpload(): Promise<number> {
    const upload = this.upload;
    if (!upload) throw new Error('当前通道没有进行中的上传');
    this.upload = null;
    const client = this.requireClient();
    await client.closeHandle(upload.handle).catch(() => undefined);
    if (upload.totalSize > 0) {
      const info = await client.stat(upload.partPath).catch(() => null);
      const actual = info ? sizeOf(info) : null;
      if (actual !== upload.totalSize) {
        throw new Error(`上传未完成：.part 实际 ${actual ?? '未知'} 字节，声明 ${upload.totalSize} 字节`);
      }
    }
    await client.rename(upload.partPath, upload.finalPath);
    return upload.offset;
  }

  private abortUpload(): void {
    const upload = this.upload;
    if (!upload) return;
    this.upload = null;
    // 只关句柄、保留 .part：下次同身份上传从这个偏移续上。
    void this.client?.closeHandle(upload.handle).catch(() => undefined);
  }

  /** cleanStaleParts 清理同名目标的陈旧残片（保留本次身份的那一个）。 */
  private async cleanStaleParts(client: SFTPClient, dir: string, filename: string, keep: string): Promise<void> {
    try {
      const entries = await this.readDirectory(client, dir || '.');
      const legacy = `${filename}.part`;
      const prefix = `${filename}.`;
      for (const entry of entries) {
        const name = entry.filename;
        if (name === keep) continue;
        let stale = name === legacy;
        if (!stale && name.startsWith(prefix) && name.endsWith('.part')) {
          stale = isIdentityPart(name.slice(prefix.length, name.length - '.part'.length));
        }
        if (!stale) continue;
        await client.removeFile(joinPath(dir, name)).catch(() => undefined);
      }
    } catch {
      // 清理是尽力而为：列目录失败只留下旧残片，不该让上传本身失败。
    }
  }

  // ===== 下载：响应先出，再分片推 =====

  /** download 打开远端文件并返回总大小与启动器。
   *  响应必须先于数据帧发出（前端靠它定文件名与总大小），所以这里不自己开跑，
   *  由调用方在写完响应之后调 start()。
   *  startOffset 供 HTTP Range 续传用：直接从该偏移开始推，不是「先读后丢」。 */
  async download(
    path: string,
    startOffset = 0,
  ): Promise<{ filename: string; total: number; start: () => void }> {
    if (this.downloading) throw new Error('本通道已有下载在进行');
    // requireClient 同时覆盖了「通道还没就绪」：客户端只在子系统握手成功后才存在。
    const client = this.requireClient();
    const attrs = await client.stat(path);
    const size = sizeOf(attrs);
    if (size === null) throw new Error('无法读取远端文件大小');
    const handle = await client.openFile(path, SFTP_OPEN_FLAGS.READ);
    const filename = path.split('/').filter(Boolean).pop() ?? 'download';
    const begin = Math.min(Math.max(Math.floor(startOffset) || 0, 0), size);
    this.downloading = true;
    return {
      filename,
      total: size,
      start: () => {
        void this.pumpDownload(client, handle, begin, size).finally(() => { this.downloading = false; });
      },
    };
  }

  private async pumpDownload(
    client: SFTPClient,
    handle: Uint8Array,
    begin: number,
    size: number,
  ): Promise<void> {
    try {
      let offset = begin;
      while (offset < size && !this.disposed) {
        const chunk = await client.readFile(handle, offset, SFTPHandler.CHUNK_SIZE);
        if (!chunk || chunk.length === 0) break;
        // 直接交给上层（浏览器方向的二进制帧）。这里**不能**走 outQueue：
        // 那条队列是往 SSH 通道里写字节的，文件内容走它会原样写回服务器。
        // 顺序天然有序 —— 每片都等上一片读回来才开始下一片。
        this.cb.data(chunk);
        offset += chunk.length;
      }
      if (this.disposed) return;
      // 最后一片带 FLAG_END：前端以此判定「传完了」。
      this.cb.data(new Uint8Array(0), true);
    } catch (error) {
      // 流被截断必须出声：只补 error、不补 FLAG_END，前端据此判定失败而非当成传完。
      this.cb.error(`download: ${messageOf(error)}`);
    } finally {
      await client.closeHandle(handle).catch(() => undefined);
    }
  }

  // ===== 出站队列 =====

  /** enqueueOut 把一段字节排进出站队列；返回的 Promise 在这段发完后了结。 */
  private enqueueOut(data: Uint8Array): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.outQueue.push({ data, end: false });
      this.outWaiters.push({ resolve, reject });
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      while (this.outQueue.length > 0 && !this.disposed) {
        const channel = this.channel;
        if (!channel) return;
        const current = this.outQueue[0];
        const chunk = channel.takeChannelDataChunk(current.data, this.outOffset);
        if (!chunk) return; // 远端窗口用尽：等下一次 WINDOW_ADJUST 续推
        await this.conn.sendChannelData(channel, chunk);
        this.outOffset += chunk.bytesConsumed;
        if (this.outOffset === current.data.length) {
          this.outQueue.shift();
          this.outOffset = 0;
          this.outWaiters.shift()?.resolve();
        }
      }
    } catch (error) {
      const failure = toError(error);
      this.outQueue.length = 0;
      this.outOffset = 0;
      for (const waiter of this.outWaiters.splice(0)) waiter.reject(failure);
      this.reportFailure(failure);
    } finally {
      this.flushing = false;
    }
  }

  /** ack 推进输入窗口（上传方向）。 */
  private ack(bytes: number): void {
    this.released += bytes;
    this.cb.control({ type: 'ack', data: { bytes: this.released } });
  }

  getHome(): string {
    return this.home;
  }
}

interface UploadState {
  handle: Uint8Array;
  partPath: string;
  finalPath: string;
  totalSize: number;
  offset: number;
}

// ===== exec =====

/** ExecHandler 一路非交互命令：收集 stdout/stderr 与退出码。 */
export class ExecHandler implements ChannelHandler {
  private channel: SSHChannel | null = null;
  // stdout 与 stderr 是两条独立的流，各自留一个解码器。
  // 共用一个的话，stdout 尾部那段「半个多字节字符」会被拼到 stderr 的开头上。
  private readonly stdoutDecoder = new TextDecoder();
  private readonly stderrDecoder = new TextDecoder();
  private stdout = '';
  private stderr = '';
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stdoutTruncated = false;
  private stderrTruncated = false;
  private exitStatus: number | null = null;
  private finished = false;

  constructor(
    private readonly conn: SSHConnection,
    private readonly command: string,
    private readonly maxBytes: number,
    private readonly done: (result: ExecResult) => void,
  ) {}

  async onOpened(channel: SSHChannel): Promise<void> {
    this.channel = channel;
    await this.conn.sendEncrypted(buildExecRequest(channel, this.command));
  }

  async onRequestResult(success: boolean): Promise<void> {
    if (!success) this.finish('服务器拒绝了 exec 请求');
  }

  onData(chunk: Uint8Array): void {
    this.append('out', chunk);
  }

  onExtendedData(chunk: Uint8Array): void {
    this.append('err', chunk);
  }

  private append(stream: 'out' | 'err', chunk: Uint8Array): void {
    const used = stream === 'out' ? this.stdoutBytes : this.stderrBytes;
    if (used >= this.maxBytes) {
      this.markTruncated(stream);
      return;
    }
    const slice = chunk.subarray(0, Math.min(chunk.length, this.maxBytes - used));
    if (slice.length < chunk.length) this.markTruncated(stream);
    // 只解自己那条流的解码器：多字节字符被 TCP 分片切断时，剩下的半个要留在原流里等下一片。
    const decoder = stream === 'out' ? this.stdoutDecoder : this.stderrDecoder;
    const text = decoder.decode(slice, { stream: true });
    if (stream === 'out') {
      this.stdout += text;
      this.stdoutBytes += slice.length;
    } else {
      this.stderr += text;
      this.stderrBytes += slice.length;
    }
  }

  private markTruncated(stream: 'out' | 'err'): void {
    if (stream === 'out') this.stdoutTruncated = true;
    else this.stderrTruncated = true;
  }

  onEof(): void { /* 等 CLOSE */ }

  onClose(): void {
    this.finish();
  }

  onOpenFailure(message: string): void {
    this.finish(message);
  }

  onExitStatus(status: number): void {
    this.exitStatus = status;
  }

  onWindowAdjust(): void { /* exec 只收不发 */ }

  private finish(failure?: string): void {
    if (this.finished) return;
    this.finished = true;
    // 把两条流里各自残留的半个多字节字符吐出来（decode() 无参 = 结束流）。
    this.stdout += this.stdoutDecoder.decode();
    this.stderr += this.stderrDecoder.decode();
    this.done({
      stdout: this.stdout,
      stderr: failure ?? this.stderr,
      exitStatus: this.exitStatus,
      stdoutTruncated: this.stdoutTruncated,
      stderrTruncated: this.stderrTruncated,
    });
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitStatus: number | null;
  /** 输出被 maxBytes 截断过；调用方据此补一行提示，避免用户以为命令只输出了这些。 */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

// ===== 通道无关的小工具 =====

/** buildExecRequest 自己拼 exec 请求。
 *  vendored 的 SSHChannel.buildExecRequest 会拒绝含换行的命令，而 managi 的批量命令
 *  正是「多条命令按换行连成一段脚本、在同一个 shell 里顺序执行」，必须允许换行。
 */
function buildExecRequest(channel: SSHChannel, command: string): Uint8Array {
  const commandBytes = new TextEncoder().encode(command);
  if (commandBytes.length === 0) throw new Error('执行命令为空');
  if (commandBytes.length > 64 * 1024) throw new Error('执行命令过长');
  const name = encodeString('exec');
  const field = encodeString(commandBytes);
  const payload = new Uint8Array(1 + 4 + name.length + 1 + field.length);
  let offset = 0;
  payload[offset++] = SSH_MSG_CHANNEL_REQUEST;
  writeUint32(payload, offset, channel.getRemoteChannelID());
  offset += 4;
  payload.set(name, offset);
  offset += name.length;
  payload[offset++] = 0x01;
  payload.set(field, offset);
  return payload;
}
