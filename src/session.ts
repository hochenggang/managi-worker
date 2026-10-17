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
import { encodeString, readUint32, toBufferSource, writeUint32 } from './ssh/utils';
import { messageOf, toError } from './util';
import { elapsedMs, logError, logInfo, logWarn } from './log';
import type { ExecHandler, PTYHandler, SFTPHandler } from './handlers';

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
  /** 主机密钥校验；返回 ok=false 时连接被拒绝。
   *  recorded=true 表示这次是**首次**信任（TOFU 新记录），调用方应当让用户看见。 */
  verifyHostKey(fingerprint: string): Promise<{ ok: boolean; reason?: string; recorded?: boolean }>;
}

/** 通道能力：SSH 连接把报文事件投给它，它决定这条通道干什么。 */
export interface ChannelHandler {
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
  private hostKeyInfo: { fingerprint: string; recorded: boolean } | null = null;
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
    const startedAt = Date.now();
    try {
      await this.write(this.transport.getLocalIdentification());
      void this.readLoop();
      await this.ready;
      logInfo('ssh.handshake.ok', {
        host: this.config.host,
        port: this.config.port,
        ms: elapsedMs(startedAt),
        kex: this.kexName,
        cipher: this.cipherC2S,
        mac: this.macC2S,
      });
    } catch (error) {
      logError('ssh.handshake.fail', {
        host: this.config.host,
        port: this.config.port,
        ms: elapsedMs(startedAt),
        reason: messageOf(error),
      });
      throw error;
    }
  }

  isReady(): boolean {
    return this.phase === 'ready';
  }

  /** getHostKeyInfo 本次连接校验过的主机密钥指纹；握手未到这一步时为 null。 */
  getHostKeyInfo(): { fingerprint: string; recorded: boolean } | null {
    return this.hostKeyInfo;
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

  /**
   * processPackets 解析入站报文并分发。
   *
   * **硬约束：这个循环只许等待传输层（解密、验签、写 socket），绝不许等待业务回调。**
   * 业务回调需要的字节往往正是「本循环下一轮才能读到的」，一次 await 就是死锁：
   * 表现是几十秒后超时，看起来像网络问题，实际是自己等自己（SFTP 开子系统踩过一次）。
   * 因此 onOpened / onRequestResult 一律 fire-and-forget，失败由 handler 上报。
   */
  private async processPackets(): Promise<void> {
    while (this.phase !== 'closed') {
      // NEWKEYS 可能在同一批 TCP 字节里同时开启入站加密，故每轮重新算分帧参数。
      const encrypted = this.decryptor !== null;
      const spec = encrypted ? getCipherSpec(this.cipherS2C) : null;
      const aead = Boolean(spec?.aead);
      const packet = await this.parser.nextPacket({
        blockSize: spec?.blockSize ?? 8,
        decrypt: encrypted
          ? (data, sequence, aad, commit) => this.decryptor!.decrypt(data, sequence, aad, commit)
          : (data) => data,
        aead,
        macLength: encrypted && !aead ? getMacSpec(this.macS2C).length : 0,
        verifyMac: this.verifier
          ? (data, mac, sequence) => this.verifier!.verify(data, sequence, mac)
          : undefined,
        // 明文阶段没有 MAC，EtM 分帧无从谈起：只按「已加密」判断，
        // 否则 NEWKEYS 之前那几个明文包会被当成 EtM 去拆（上一轮真踩过）。
        encryptThenMac: encrypted && isEtmMacAlgorithm(this.macS2C),
      });
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
    // 首连信任是静默发生的 —— 这正是 MITM 最喜欢的位置。把它记下来交给上层，
    // 让「刚刚信任了哪个指纹」能在界面上出现一次。
    this.hostKeyInfo = { fingerprint, recorded: trust.recorded === true };
    if (trust.recorded) logWarn('ssh.hostkey.recorded', { host: this.config.host, port: this.config.port, fingerprint });

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
      // 这里同样**不能 await**：onOpened 只是发「pty-req / subsystem」这类请求，
      // 而它的应答（CHANNEL_SUCCESS）要由本循环消费。任何「等应答」的回调一旦被 await，
      // 循环就在等自己 —— SFTP 那次 30 秒超时正是这么来的。
      // 回调自身抛错由各 handler 报给通道，这里只兜住意外。
      void Promise.resolve(handler.onOpened(channel))
        .catch((error) => handler.onOpenFailure(messageOf(error)));
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
      // 这里**不能 await**：SFTP 的 onRequestResult 要等 SFTP INIT/VERSION 往返，
      // 而 VERSION 那批字节正是由这个报文循环自己消费的 —— await 等于让循环等自己，
      // 表现为「SFTP request 0 timed out」（30s 后超时，看起来像网络问题）。
      // PTY / exec 的 onRequestResult 只发下一个请求、不等往返，本来就不会自锁；
      // 改成统一不阻塞后它们的行为不变（sendEncrypted 内部已按序串行）。
      // 失败由各 handler 自己报给通道，这里只兜住回调本身抛出的意外。
      void Promise.resolve(handler.onRequestResult(type === SSH_MSG_CHANNEL_SUCCESS))
        .catch((error) => handler.onOpenFailure(messageOf(error)));
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
        {
          blockSize: spec.blockSize,
          encrypt: (data, sequence, aad) => this.encryptor!.encrypt(data, sequence, aad),
          seqNum: this.sendSequence,
          aead: spec.aead,
          mac: this.signer ? (data, sequence) => this.signer!.sign(data, sequence) : undefined,
          encryptThenMac: isEtmMacAlgorithm(this.macC2S),
        },
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
      const packet = await SSHPacketBuilder.build(payload, {
        blockSize: 8,
        encrypt: null,
        seqNum: this.sendSequence,
      });
      this.sendSequence = nextSequenceNumber(this.sendSequence);
      await this.write(packet);
    });
  }

  /** sendEncrypted 发一个加密报文；通道处理器用它发通道请求。 */
  async sendEncrypted(payload: Uint8Array): Promise<void> {
    await this.serialSend(async () => {
      if (!this.encryptor) throw new Error('SSH 加密尚未初始化');
      const spec = getCipherSpec(this.cipherC2S);
      const packet = await SSHPacketBuilder.build(payload, {
        blockSize: spec.blockSize,
        encrypt: (data, sequence, aad) => this.encryptor!.encrypt(data, sequence, aad),
        seqNum: this.sendSequence,
        aead: spec.aead,
        mac: this.signer ? (data, sequence) => this.signer!.sign(data, sequence) : undefined,
        encryptThenMac: isEtmMacAlgorithm(this.macC2S),
      });
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
    // 每条连接死掉都要留痕：包括「用户看到的那句话」和它发生在哪一段。
    // 没有这行，线上只能看到前端弹一次错，事后完全无法复盘。
    logWarn('ssh.ended', {
      host: this.config.host,
      port: this.config.port,
      phase: this.phase,
      reason: messageOf(error),
    });
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

// 处理器从这里转出：调用方（worker / DO / 测试）一直是从 session 拿它们，
// 拆分不该让外部跟着改 import。
export { ExecHandler, PTYHandler, SFTPHandler } from './handlers';
export type { ExecResult } from './handlers';
