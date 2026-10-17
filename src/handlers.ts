// 三种通道处理器：PTY（终端）、SFTP（文件管理）、exec（一次性命令）。
//
// 为什么单独一个文件：session.ts 之前同时住着 SSH 传输编排、认证流程和这三个处理器，
// 1700 行里谁都能改到谁。传输与「通道里干什么」是两件事，改一个不该顺手动到另一个。
// 这三个类只依赖 SSHConnection 的公开方法，不碰传输层内部状态。

import { SSH_MSG_CHANNEL_REQUEST } from './types';
import { encodeString, writeUint32 } from './ssh/utils';
import { SFTPClient, SFTP_OPEN_FLAGS, type SFTPAttrs } from './ssh/sftp';
import type { SSHChannel } from './ssh/channel';
import { messageOf } from './util';
import { OutboundQueue } from './outbound';
import { elapsedMs, logError, logInfo, logWarn } from './log';
import {
  isDirectory,
  isIdentityPart,
  joinPath,
  partFilePath,
  sizeOf,
  toFileItem,
  type FileItemOut,
} from './file-meta';
import type { ChannelCallbacks, ChannelHandler, SSHConnection } from './session';

// ===== PTY =====

/** PTYHandler 一路终端：输入入队、输出成帧、按消费进度回 ack 推进前端窗口。 */
export class PTYHandler implements ChannelHandler {
  static readonly OUT_FRAME = 32 * 1024;
  /** 客户端 → 服务端单帧上限，随 open 响应下发，前端据此切粘贴分片。 */
  static readonly IN_FRAME = 32 * 1024;
  /** 输入窗口：前端未确认字节超过它就停下等待 ack。 */
  static readonly WINDOW = 256 * 1024;

  private channel: SSHChannel | null = null;
  private closed = false;
  private shellRequested = false;
  private readySent = false;
  private released = 0;
  /** 输入按序写进通道；与 SFTP 共用同一套队列（见 outbound.ts）。 */
  private readonly outbound: OutboundQueue<Uint8Array>;

  constructor(
    private readonly conn: SSHConnection,
    private readonly cols: number,
    private readonly rows: number,
    private readonly cb: ChannelCallbacks,
  ) {
    this.outbound = new OutboundQueue<Uint8Array>({
      takeChunk: (item, offset) => this.channel?.takeChannelDataChunk(item, offset) ?? null,
      send: (chunk) => this.conn.sendChannelData(this.channel!, chunk),
      lengthOf: (item) => item.length,
      isClosed: () => this.closed,
      onChunk: (bytes) => this.ack(bytes),
      // 写不进去就等于终端已经废了：出声，别让用户对着一个「看着正常」的死终端敲字。
      onFailure: (error) => this.cb.error(messageOf(error)),
    });
  }

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
    void this.outbound.flush();
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
    this.outbound.clear();
    this.cb.data(new Uint8Array(0), true);
  }

  onOpenFailure(message: string): void {
    this.cb.failed(message);
  }

  onExitStatus(): void {
    // 终端场景用不到退出码；通道关闭时前端会看到「会话已结束」。
  }

  onWindowAdjust(): void {
    void this.outbound.flush();
  }

  /** queueInput 收下前端的一片输入；由上层保证调用顺序。 */
  queueInput(payload: Uint8Array): void {
    if (this.closed || payload.length === 0) return;
    // 失败由 onFailure 统一出声，这里不重复处理，只把 rejection 认领掉。
    this.outbound.enqueue(payload).catch(() => undefined);
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
  /** 单次列目录最多返回多少条。再多的目录应当用终端或 find 去看。 */
  static readonly MAX_LIST_ENTRIES = 10_000;
  /** 递归删除的层级上限：挡住「删 /」这类把自己删到天荒地老的操作。 */
  static readonly MAX_REMOVE_DEPTH = 64;
  /** 一次递归删除最多处理多少条。 */
  static readonly MAX_REMOVE_ENTRIES = 10_000;
  /** 单个文件的上传上限。 */
  static readonly MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

  private channel: SSHChannel | null = null;
  private client: SFTPClient | null = null;
  private home = '/';
  private disposed = false;
  private subsystemRequested = false;
  private openedAt = 0;

  /**
   * 出站队列：只走 **SFTP 协议包**（请求 / 应答往服务器去的那一半）。
   * 上传与下载的文件内容不经过这里 —— 上传直接写 file handle，下载直接交给上层回调。
   * 串成一条队列是为了保证报文按生成的先后写上通道，协议栈才不会收到错位的响应。
   */
  private readonly outbound: OutboundQueue<Uint8Array>;

  private upload: UploadState | null = null;
  private released = 0;
  private downloading = false;

  constructor(
    private readonly conn: SSHConnection,
    private readonly cb: ChannelCallbacks,
  ) {
    this.outbound = new OutboundQueue<Uint8Array>({
      takeChunk: (item, offset) => this.channel?.takeChannelDataChunk(item, offset) ?? null,
      send: (chunk) => this.conn.sendChannelData(this.channel!, chunk),
      lengthOf: (item) => item.length,
      isClosed: () => this.disposed,
      onFailure: (error) => this.reportFailure(error),
    });
  }

  async onOpened(channel: SSHChannel): Promise<void> {
    this.channel = channel;
    this.openedAt = Date.now();
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
      logInfo('sftp.open.ok', { ms: elapsedMs(this.openedAt), version: info.version, home });
      this.cb.ready(home);
    } catch (error) {
      logError('sftp.open.fail', { ms: elapsedMs(this.openedAt), reason: messageOf(error) });
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
    void this.outbound.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortUpload();
    this.outbound.clear();
    try { this.client?.dispose(); } catch { /* 已销毁 */ }
    this.client = null;
  }

  private reportFailure(error: unknown): void {
    const message = messageOf(error);
    this.cb.error(message);
    this.dispose();
  }

  // ===== 目录操作 =====

  async list(path: string): Promise<{ path: string; files: FileItemOut[]; truncated?: boolean }> {
    const client = this.requireClient();
    if (!path) throw new Error('路径不能为空');
    const resolved = await this.realpathSafe(client, path);
    const handle = await client.openDir(resolved);
    const files: FileItemOut[] = [];
    let truncated = false;
    try {
      for (;;) {
        const batch = await client.readDir(handle);
        if (!batch || batch.length === 0) break;
        for (const entry of batch) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          // 上限不是「怕慢」，是怕一个百万文件的目录把 isolate 的内存吃光。
          // 到顶就停读并如实告知，绝不让前端以为这就是全部。
          if (files.length >= SFTPHandler.MAX_LIST_ENTRIES) {
            truncated = true;
            break;
          }
          files.push(toFileItem(entry.filename, entry.attrs));
        }
        if (truncated) break;
      }
    } finally {
      await client.closeHandle(handle).catch(() => undefined);
    }
    if (truncated) {
      logWarn('sftp.list.truncated', { path: resolved, limit: SFTPHandler.MAX_LIST_ENTRIES });
    }
    return truncated ? { path: resolved, files, truncated } : { path: resolved, files };
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
    await this.removeDirectory(client, path, 0, { count: 0 });
  }

  /**
   * removeDirectory 递归删除。
   *
   * depth / budget 是硬闸：没有它们，一次误点的 `rm /` 会以「30 秒后 SFTP 超时」
   * 的形式失败——半删状态，而且没人知道它到底删到哪了。
   */
  private async removeDirectory(
    client: SFTPClient,
    path: string,
    depth: number,
    budget: { count: number },
  ): Promise<void> {
    if (depth >= SFTPHandler.MAX_REMOVE_DEPTH) {
      throw new Error(`目录层级超过 ${SFTPHandler.MAX_REMOVE_DEPTH} 层（${path}），请改用终端删除`);
    }
    const entries = await this.readDirectory(client, path);
    for (const entry of entries) {
      if (budget.count >= SFTPHandler.MAX_REMOVE_ENTRIES) {
        throw new Error(`本次删除已处理 ${SFTPHandler.MAX_REMOVE_ENTRIES} 个条目，已达上限，请分批或用终端`);
      }
      budget.count += 1;
      const child = joinPath(path, entry.filename);
      if (isDirectory(entry.attrs)) await this.removeDirectory(client, child, depth + 1, budget);
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
    // 声明的长度也要挡：前端拿到的 size 来自本地文件，但服务端不能假设它诚实。
    if (size > SFTPHandler.MAX_UPLOAD_BYTES) {
      throw new Error(`文件超过上传上限 ${SFTPHandler.MAX_UPLOAD_BYTES >> 20}MB`);
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
    // size=0（未知长度）时上面那条闸不会响，这里用累计量兜底：
    // 否则一个「声明 0 字节」的上传可以无限写，直到把远端磁盘填满。
    if (upload.offset + payload.byteLength > SFTPHandler.MAX_UPLOAD_BYTES) {
      this.abortUpload();
      throw new Error(`上传超过上限 ${SFTPHandler.MAX_UPLOAD_BYTES >> 20}MB，已中止（.part 已保留）`);
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

  /** statSize 只取远端文件大小（HTTP Range 要先知道总长才能解析区间）。 */
  async statSize(path: string): Promise<number> {
    const client = this.requireClient();
    const attrs = await client.stat(path);
    const size = sizeOf(attrs);
    if (size === null) throw new Error('无法读取远端文件大小');
    return size;
  }

  /** download 打开远端文件并返回总大小与启动器。
   *  响应必须先于数据帧发出（前端靠它定文件名与总大小），所以这里不自己开跑，
   *  由调用方在写完响应之后调 start()。
   *  startOffset / endOffset 供 HTTP Range 续传用：直接从该偏移开始推，不是「先读后丢」。
   *  endOffset 是**闭区间**终点；不传就推到文件尾（WS 下载走这条）。 */
  async download(
    path: string,
    startOffset = 0,
    endOffset = Number.POSITIVE_INFINITY,
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
    const last = Math.min(Math.floor(endOffset), size - 1);
    this.downloading = true;
    return {
      filename,
      total: size,
      start: () => {
        void this.pumpDownload(client, handle, begin, size, last).finally(() => { this.downloading = false; });
      },
    };
  }

  private async pumpDownload(
    client: SFTPClient,
    handle: Uint8Array,
    begin: number,
    size: number,
    last: number,
  ): Promise<void> {
    try {
      let offset = begin;
      while (offset <= last && !this.disposed) {
        // 最后一片按区间截断：Range 请求不该多送一个字节，否则 Content-Length 就对不上。
        const want = Math.min(SFTPHandler.CHUNK_SIZE, last - offset + 1);
        const chunk = await client.readFile(handle, offset, want);
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

  /** enqueueOut 把一段 SFTP 协议报文排进出站队列；返回的 Promise 在这段发完后了结。 */
  private enqueueOut(data: Uint8Array): Promise<void> {
    return this.outbound.enqueue(data);
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
