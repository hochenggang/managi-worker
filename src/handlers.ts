// 两种通道处理器：PTY（终端）、SFTP（文件管理）。
//
// 为什么单独一个文件：session.ts 之前同时住着 SSH 传输编排、认证流程和这些处理器，
// 1700 行里谁都能改到谁。传输与「通道里干什么」是两件事，改一个不该顺手动到另一个。
// 这两个类只依赖 SSHConnection 的公开方法，不碰传输层内部状态。

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

// ===== EXEC =====

/**
 * ExecHandler 一路非交互命令（批量执行的一路）。
 *
 * 与 PTY 的区别不止「要不要 PTY」：stdout 与 stderr 天然分开、没有窗口流控、
 * 也不需要输入。因此它只做三件事：发 exec 请求、把两路输出带标志转发、报退出码。
 *
 * 「命令跑了但返回非零」与「通道坏了」必须能被前端分开：前者是结果（exit 帧），
 * 后者是错误（error 帧）。混在一起的话，批量执行会把失败报成成功，或反过来。
 */
export class ExecHandler implements ChannelHandler {
  /** 单路（stdout / stderr 各自）输出上限：`yes`、`cat /dev/urandom` 不能让 isolate 吃满内存。 */
  static readonly MAX_STREAM_BYTES = 4 * 1024 * 1024;
  /** 响应写出前最多替对端缓冲多少输出；正常情况 server 先回 SUCCESS 再发数据，用不到这么大。 */
  private static readonly PRE_START_LIMIT = 256 * 1024;

  private channel: SSHChannel | null = null;
  private closed = false;
  private started = false;
  private exitCode: number | null = null;
  private readonly sent = { stdout: 0, stderr: 0 };
  private readonly truncated = { stdout: false, stderr: false };
  /** 响应写出之前先攒着：否则前端会先收到一批还不认识 chan 的字节。 */
  private queue: Array<{ chunk: Uint8Array; stderr: boolean }> = [];
  private queuedBytes = 0;

  constructor(
    private readonly conn: SSHConnection,
    private readonly command: string,
    private readonly cb: ChannelCallbacks,
  ) {}

  async onOpened(channel: SSHChannel): Promise<void> {
    this.channel = channel;
    await this.conn.sendEncrypted(channel.buildExecRequest(this.command));
  }

  async onRequestResult(success: boolean): Promise<void> {
    if (!success) {
      this.cb.failed('服务器拒绝执行该命令');
      this.conn.close();
      return;
    }
    this.cb.ready();
  }

  /** start 由上层在 open 响应写出之后调用：把攒下的输出按序放出去。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const item of queued) this.emit(item.chunk, item.stderr);
  }

  onData(chunk: Uint8Array): void {
    this.accept(chunk, false);
  }

  onExtendedData(chunk: Uint8Array): void {
    this.accept(chunk, true);
  }

  onEof(): void { /* exec 的收尾走 onClose：EOF 之后还有 exit-status */ }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cb.control({
      type: 'exit',
      data: {
        code: this.exitCode,
        truncated_stdout: this.truncated.stdout,
        truncated_stderr: this.truncated.stderr,
      },
    });
    this.cb.data(new Uint8Array(0), true);
  }

  onWindowAdjust(): void { /* exec 没有输入方向，窗口无用 */ }

  onOpenFailure(message: string): void {
    this.cb.failed(message);
  }

  onExitStatus(code: number): void {
    this.exitCode = code;
  }

  private accept(chunk: Uint8Array, stderr: boolean): void {
    if (this.closed || chunk.length === 0) return;
    if (!this.started) {
      if (this.queuedBytes + chunk.length > ExecHandler.PRE_START_LIMIT) {
        // 服务端没等 SUCCESS 就灌数据：丢掉超出的部分，但仍然如实标记截断。
        this.truncated[stderr ? 'stderr' : 'stdout'] = true;
        return;
      }
      this.queue.push({ chunk, stderr });
      this.queuedBytes += chunk.length;
      return;
    }
    this.emit(chunk, stderr);
  }

  private emit(chunk: Uint8Array, stderr: boolean): void {
    const key = stderr ? 'stderr' : 'stdout';
    const room = ExecHandler.MAX_STREAM_BYTES - this.sent[key];
    if (room <= 0) {
      this.truncated[key] = true;
      return;
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (chunk.length > room) this.truncated[key] = true;
    this.sent[key] += slice.length;
    this.cb.data(slice, false, stderr);
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
  /**
   * 单个文件的上传与下载上限，两边共用一个数。
   *
   * 下载走 WS、整份缓冲在浏览器内存里（没有第二条流式通道了），10MB 是
   * 「够传配置与日志、又不至于把标签页顶爆」的分界。超过就明确拒绝，
   * 不做截断——半个文件比没有文件更糟。
   */
  static readonly MAX_FILE_BYTES = 10 * 1024 * 1024;

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

  /**
   * readDirectory 读出全部条目。READDIR 的属性是条目自身的属性（等同 lstat）。
   *
   * 与 list 不同，这里不截断而是**报错**：两个调用方（递归删除、清理上传残片）
   * 只要拿到半份列表就会做错事——少读的条目没被删、旧残片没被清。
   * 上限存在的理由同样是内存：一个百万文件的目录足以把 isolate 吃光。
   */
  private async readDirectory(
    client: SFTPClient,
    path: string,
    limit: number = SFTPHandler.MAX_LIST_ENTRIES,
  ): Promise<{ filename: string; attrs: SFTPAttrs }[]> {
    const handle = await client.openDir(path);
    const entries: { filename: string; attrs: SFTPAttrs }[] = [];
    try {
      for (;;) {
        const batch = await client.readDir(handle);
        if (!batch || batch.length === 0) break;
        for (const entry of batch) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          if (entries.length >= limit) {
            throw new Error(`目录 ${path} 的条目超过 ${limit} 个，请改用终端处理`);
          }
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
    if (size > SFTPHandler.MAX_FILE_BYTES) {
      throw new Error(`文件超过上传上限 ${SFTPHandler.MAX_FILE_BYTES >> 20}MB`);
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
    if (upload.offset + payload.byteLength > SFTPHandler.MAX_FILE_BYTES) {
      this.abortUpload();
      throw new Error(`上传超过上限 ${SFTPHandler.MAX_FILE_BYTES >> 20}MB，已中止（.part 已保留）`);
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

  /**
   * download 打开远端文件，返回文件名、总长与「开始推字节」的启动器。
   *
   * 响应头必须先于数据帧发出（前端靠它定文件名与总长），所以这里不自己开跑，
   * 由调用方写完响应之后调 start()。stat 与 open 都在这一步做完：
   * 大小既写进响应头，也决定推多少字节，不必再单独 stat 一次。
   */
  async download(path: string): Promise<{ filename: string; total: number; start: () => void }> {
    if (this.downloading) throw new Error('本通道已有下载在进行');
    // requireClient 同时覆盖了「通道还没就绪」：客户端只在子系统握手成功后才存在。
    const client = this.requireClient();
    const attrs = await client.stat(path);
    // 目录大小在各家服务器上语义不一（0 / 4096 / 块数），当文件下发只会让人困惑。
    if (isDirectory(attrs)) throw new Error('这是一个目录，不能按文件下载');
    const size = sizeOf(attrs);
    if (size === null) throw new Error('无法读取远端文件大小');
    // 先判大小再开句柄：超过上限的文件不该占住一个远端文件句柄。
    if (size > SFTPHandler.MAX_FILE_BYTES) {
      throw new Error(`文件 ${formatMB(size)}，超过下载上限 ${SFTPHandler.MAX_FILE_BYTES >> 20}MB`);
    }
    const handle = await client.openFile(path, SFTP_OPEN_FLAGS.READ);
    const filename = path.split('/').filter(Boolean).pop() ?? 'download';
    this.downloading = true;
    return {
      filename,
      total: size,
      start: () => {
        void this.pumpDownload(client, handle, size - 1).finally(() => { this.downloading = false; });
      },
    };
  }

  /** pumpDownload 从 0 读到 last（闭区间）。空文件 last = -1，循环不进、直接补结束帧。 */
  private async pumpDownload(client: SFTPClient, handle: Uint8Array, last: number): Promise<void> {
    try {
      let offset = 0;
      while (offset <= last && !this.disposed) {
        // 最后一片按剩余字节截断：多送一个字节，Content-Length 就对不上。
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
      // 读到的比 stat 说的少（文件在传输途中被截断 / 日志轮转）：必须报错。
      // 只补 END 的话，下游会收到一个长度不足却被标记为「传完了」的文件。
      if (offset <= last) {
        this.cb.error(`download: 远端文件在传输中变短（读到 ${offset} 字节，期望 ${last + 1} 字节）`);
        return;
      }
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

// ===== 通道无关的小工具 =====

/** formatMB 把字节数说成人能看懂的大小（512KB / 10.4MB）。 */
function formatMB(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
