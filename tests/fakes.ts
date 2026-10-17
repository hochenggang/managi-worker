// 测试替身：SSH 连接、通道、SFTP 客户端。
//
// 目标不是模拟 SSH 协议（那是 src/ssh/ 逐字保留的第三方栈，要真实服务端才有意义），
// 而是把「上层编排逻辑」从协议栈里剥出来单独验收 —— 窗口流控、递归删除、断点续传、
// 通道分发这些才是本项目自己写的部分，也才是会出错的部分。
//
// 替身一律「行为可编程、调用可断言」：用例通过字段注入结果，通过数组检查调用。

// 注意：这里只从 `ssh/sftp-types` 取常量与类型，**不**从 `ssh/sftp` 导入任何东西。
// session.test.ts 会把 `ssh/sftp` 整个换成 MockSFTPClient，若本文件也从那里取常量，
// 就会形成「工厂 → fakes → 工厂」的循环初始化。
import { SFTP_OPEN_FLAGS, type SFTPAttrs } from '../src/ssh/sftp-types';

// ===== 通道 =====

export interface FakeChannelOptions {
  remoteChannelID?: number;
  /** 远端窗口还剩多少字节可发；默认无限，用例可调小以验证「等 WINDOW_ADJUST」。 */
  window?: number;
}

export interface FakeDataChunk {
  source: Uint8Array;
  sourceOffset: number;
  bytesConsumed: number;
  payloadLength: number;
}

export class FakeChannel {
  readonly requests: Array<{ name: string; args: string }> = [];
  private windowRemaining: number;

  constructor(private readonly options: FakeChannelOptions = {}) {
    this.windowRemaining = options.window ?? Number.POSITIVE_INFINITY;
  }

  getRemoteChannelID(): number {
    return this.options.remoteChannelID ?? 7;
  }

  buildPTYRequest(cols: number, rows: number, terminal: string): Uint8Array {
    return this.record('pty-req', `${cols}x${rows}:${terminal}`);
  }

  buildShellRequest(): Uint8Array {
    return this.record('shell', '');
  }

  buildSubsystemRequest(subsystem: string): Uint8Array {
    return this.record('subsystem', subsystem);
  }

  /** takeChannelDataChunk 与真实实现同语义：窗口用尽返回 null（调用方应停下等 adjust）。 */
  takeChannelDataChunk(data: Uint8Array, offset = 0): FakeDataChunk | null {
    const available = data.length - offset;
    if (available <= 0 || this.windowRemaining <= 0) return null;
    const bytesConsumed = Math.min(available, this.windowRemaining);
    this.windowRemaining -= bytesConsumed;
    return { source: data, sourceOffset: offset, bytesConsumed, payloadLength: bytesConsumed };
  }

  /** grantWindow 补上远端窗口，供用例模拟收到 WINDOW_ADJUST。 */
  grantWindow(bytes: number): void {
    if (this.windowRemaining !== Number.POSITIVE_INFINITY) this.windowRemaining += bytes;
  }

  requestNames(): string[] {
    return this.requests.map((item) => item.name);
  }

  private record(name: string, args: string): Uint8Array {
    this.requests.push({ name, args });
    // 内容无关紧要，只需要是一段非空字节：真实报文的首字节是 98（CHANNEL_REQUEST）。
    const payload = new TextEncoder().encode(`\x62${name}:${args}`);
    return payload;
  }
}

// ===== 连接 =====

export interface FakeConnectionOptions {
  /** handshake() 的失败原因；给了就以它拒绝。 */
  handshakeError?: Error;
  /** openPTY/openSFTP 是否自动把通道推到「就绪」。默认 true。 */
  autoReady?: boolean;
}

export class FakeConnection {
  readonly sentEncrypted: Uint8Array[] = [];
  readonly channelData: number[] = [];
  readonly closedChannels: number[] = [];
  readonly resizes: Array<{ localId: number; cols: number; rows: number }> = [];
  readonly handlers: Array<{ kind: string; localId: number; handler: ReadyCapable }> = [];
  readonly channel = new FakeChannel();

  closeCount = 0;
  handshakeCount = 0;
  /** 握手时校验过的主机密钥；默认没有，用例可覆盖。 */
  hostKeyInfo: { fingerprint: string; recorded: boolean } | null = null;
  private localId = 0;

  constructor(private readonly options: FakeConnectionOptions = {}) {}

  async handshake(): Promise<void> {
    this.handshakeCount += 1;
    if (this.options.handshakeError) throw this.options.handshakeError;
  }

  getHostKeyInfo(): { fingerprint: string; recorded: boolean } | null {
    return this.hostKeyInfo;
  }

  async sendEncrypted(payload: Uint8Array): Promise<void> {
    this.sentEncrypted.push(payload);
  }

  async sendChannelData(_channel: unknown, chunk: { bytesConsumed: number }): Promise<void> {
    this.channelData.push(chunk.bytesConsumed);
  }

  openPTY(handler: ReadyCapable): number {
    return this.register('pty', handler);
  }

  openSFTP(handler: ReadyCapable): number {
    return this.register('sftp', handler);
  }

  openExec(handler: ReadyCapable): number {
    return this.register('exec', handler);
  }

  closeChannel(localId: number): void {
    this.closedChannels.push(localId);
  }

  resizePTY(localId: number, cols: number, rows: number): void {
    this.resizes.push({ localId, cols, rows });
  }

  close(): void {
    this.closeCount += 1;
  }

  handlerOf(kind: string): unknown {
    return this.handlers.find((item) => item.kind === kind)?.handler;
  }

  private register(kind: string, handler: ReadyCapable): number {
    this.localId += 1;
    const localId = this.localId;
    this.handlers.push({ kind, localId, handler });
    if (this.options.autoReady !== false) {
      queueMicrotask(() => handler.ready?.());
    }
    return localId;
  }
}

/** 替身握手完成后用来通知「通道就绪」的入口（真实实现由协议栈回调触发）。 */
export interface ReadyCapable {
  ready?: () => void;
}

// ===== 通道处理器替身 =====
//
// worker.ts 与 durable-object.ts 只通过这些类的「构造参数 + 方法调用」与 SSH 层耦合，
// 所以整类换掉就能把路由 / 分发逻辑单独验收，不必牵扯协议栈。

export interface FakeCallbacks {
  data(payload: Uint8Array, end?: boolean): void;
  control(envelope: { type: string; data?: unknown }): void;
  error(message: string): void;
  ready(info?: string): void;
  failed(message: string): void;
}

/** FakeExecHandler 记录被要求执行的命令，并让用例自己决定何时给出结果。 */
export class FakeExecHandler {
  static readonly created: FakeExecHandler[] = [];
  static reset(): void {
    FakeExecHandler.created.length = 0;
  }

  readonly command: string;
  readonly maxBytes: number;

  constructor(
    _conn: unknown,
    command: string,
    maxBytes: number,
    private readonly done: (result: unknown) => void,
  ) {
    this.command = command;
    this.maxBytes = maxBytes;
    FakeExecHandler.created.push(this);
  }

  /** finish 模拟命令跑完。 */
  finish(result: unknown): void {
    this.done(result);
  }
}

/** FakePTYHandler 只关心「输入有没有交到 SSH 层」与「怎么宣布就绪」。 */
export class FakePTYHandler {
  static readonly OUT_FRAME = 32 * 1024;
  static readonly IN_FRAME = 32 * 1024;
  static readonly WINDOW = 256 * 1024;

  static readonly created: FakePTYHandler[] = [];
  static reset(): void {
    FakePTYHandler.created.length = 0;
  }

  readonly inputs: Uint8Array[] = [];
  /** 置为错误文案时，就绪会走失败分支。 */
  readyFailure: string | null = null;
  readyInfo: string | undefined;

  constructor(
    _conn: unknown,
    readonly cols: number,
    readonly rows: number,
    readonly cb: FakeCallbacks,
  ) {
    FakePTYHandler.created.push(this);
  }

  ready(): void {
    if (this.readyFailure !== null) this.cb.failed(this.readyFailure);
    else this.cb.ready(this.readyInfo);
  }

  queueInput(payload: Uint8Array): void {
    this.inputs.push(payload);
  }
}

export interface FakeDownloadMeta {
  filename: string;
  total: number;
  chunks: Uint8Array[];
  /** true 时 start() 不补 END 标记 —— 用来测「下游还开着的时候出错」。 */
  stayOpen?: boolean;
}

/**
 * FakeSFTPPlan 是「还没拿到实例就已经被消费掉」的那批配置。
 *
 * 为什么不能事后改实例字段：连接替身会在 microtask 里自动宣布通道就绪
 * （`autoReady`），紧接着 `download()` 就被 await 了 —— 用例根本来不及
 * 从 `created` 里取出实例再赋值。所以这几个值必须在**发请求之前**交出去。
 */
export interface FakeSFTPPlan {
  listResult?: { path: string; files: unknown[]; truncated?: boolean };
  listError?: Error | null;
  mkdirError?: Error | null;
  removeError?: Error | null;
  beginUploadResult?: { offset: number; chunk_size: number };
  beginUploadError?: Error | null;
  finishUploadSize?: number;
  finishUploadError?: Error | null;
  downloadError?: Error | null;
  downloadMeta?: FakeDownloadMeta;
  readyFailure?: string | null;
  readyInfo?: string | undefined;
}

/** applyPlan 只覆盖 plan 里显式给出的字段，没给出的保留字段自身默认值。 */
function applyPlan(target: object, plan: object): void {
  for (const [key, value] of Object.entries(plan)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

/** FakeSFTPHandler 记录目录操作，并让用例编排下载流。 */
export class FakeSFTPHandler {
  static readonly CHUNK_SIZE = 64 * 1024;
  static readonly WINDOW = 1024 * 1024;

  static readonly created: FakeSFTPHandler[] = [];
  /** 下一个实例要套用的配置；用例在发请求前设置。 */
  static plan: FakeSFTPPlan = {};
  static reset(): void {
    FakeSFTPHandler.created.length = 0;
    FakeSFTPHandler.plan = {};
  }

  readonly listCalls: string[] = [];
  readonly mkdirCalls: string[] = [];
  readonly removeCalls: string[] = [];
  readonly uploadCalls: Array<{ dir: string; filename: string; size: number; mtime: number }> = [];
  readonly downloadCalls: Array<{ path: string; offset: number; endOffset?: number }> = [];
  readonly statSizeCalls: string[] = [];
  readonly written: Uint8Array[] = [];

  /** 目录操作的返回值 / 抛错，用例按需设置。 */
  listResult: { path: string; files: unknown[] } = { path: '/', files: [] };
  listError: Error | null = null;
  mkdirError: Error | null = null;
  removeError: Error | null = null;
  beginUploadResult = { offset: 0, chunk_size: 64 * 1024 };
  beginUploadError: Error | null = null;
  finishUploadSize = 0;
  finishUploadError: Error | null = null;
  downloadError: Error | null = null;
  /** 下载的元信息与要推的字节。 */
  downloadMeta: FakeDownloadMeta = { filename: 'report.csv', total: 0, chunks: [] };

  readyFailure: string | null = null;
  readyInfo: string | undefined = '/home/tester';
  /** 记录 start() 被调用了几次 —— 响应必须先出、数据后走。 */
  started = 0;

  constructor(
    _conn: unknown,
    readonly cb: FakeCallbacks,
  ) {
    applyPlan(this, FakeSFTPHandler.plan);
    FakeSFTPHandler.created.push(this);
  }

  ready(): void {
    if (this.readyFailure !== null) this.cb.failed(this.readyFailure);
    else this.cb.ready(this.readyInfo);
  }

  async list(path: string): Promise<{ path: string; files: unknown[] }> {
    this.listCalls.push(path);
    if (this.listError) throw this.listError;
    return this.listResult;
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
    if (this.mkdirError) throw this.mkdirError;
  }

  async remove(path: string): Promise<void> {
    this.removeCalls.push(path);
    if (this.removeError) throw this.removeError;
  }

  async beginUpload(dir: string, filename: string, size: number, mtime: number): Promise<{ offset: number; chunk_size: number }> {
    this.uploadCalls.push({ dir, filename, size, mtime });
    if (this.beginUploadError) throw this.beginUploadError;
    return this.beginUploadResult;
  }

  async writeData(payload: Uint8Array): Promise<void> {
    this.written.push(payload);
  }

  async finishUpload(): Promise<number> {
    if (this.finishUploadError) throw this.finishUploadError;
    return this.finishUploadSize;
  }

  /** statSize 与真实现对齐：Range 解析要先知道总长。 */
  async statSize(path: string): Promise<number> {
    this.statSizeCalls.push(path);
    if (this.downloadError) throw this.downloadError;
    return this.downloadMeta.total;
  }

  async download(
    path: string,
    offset = 0,
    endOffset = Number.POSITIVE_INFINITY,
  ): Promise<{ filename: string; total: number; start: () => void }> {
    this.downloadCalls.push({ path, offset, endOffset });
    if (this.downloadError) throw this.downloadError;
    const meta = this.downloadMeta;
    return {
      filename: meta.filename,
      total: meta.total,
      start: () => {
        this.started += 1;
        for (const chunk of meta.chunks) this.cb.data(chunk);
        if (!meta.stayOpen) this.cb.data(new Uint8Array(0), true);
      },
    };
  }
}

// ===== SFTP 客户端 =====

export interface FakeDirEntry {
  filename: string;
  attrs: SFTPAttrs;
}

export const FILE_MODE = 0o100644;
export const DIR_MODE = 0o040755;
export const SYMLINK_MODE = 0o120777;

/** attrs 造一份 SFTPAttrs：flags 是必填字段，所以给个默认值。 */
export function attrs(init: Partial<SFTPAttrs> = {}): SFTPAttrs {
  return { flags: 0, ...init };
}

export function fileAttrs(size: number): SFTPAttrs {
  return attrs({ size, permissions: FILE_MODE });
}

export function dirAttrs(): SFTPAttrs {
  return attrs({ permissions: DIR_MODE });
}

export function symlinkAttrs(): SFTPAttrs {
  return attrs({ permissions: SYMLINK_MODE });
}

/**
 * FakeSFTPClient 覆盖 SFTPHandler 会调到的全部方法。
 * `tree` 喂目录内容（key 是目录路径），`files` 喂文件内容（下载读它）。
 */
export class FakeSFTPClient {
  version = 3;
  realpathResult = '/home/tester';
  realpathError: Error | null = null;

  readonly tree = new Map<string, FakeDirEntry[]>();
  readonly files = new Map<string, Uint8Array>();
  readonly stats = new Map<string, SFTPAttrs>();

  readonly createdDirs: string[] = [];
  readonly removedFiles: string[] = [];
  readonly removedDirs: string[] = [];
  readonly renames: Array<{ from: string; to: string }> = [];
  readonly writes: Array<{ offset: number; length: number }> = [];
  readonly openedFiles: Array<{ path: string; flags: number }> = [];
  readonly closedHandles: Uint8Array[] = [];
  readonly feeds: Uint8Array[] = [];

  disposeCalls = 0;
  writeError: Error | null = null;
  readError: Error | null = null;
  statError: Error | null = null;

  private readonly dirHandles = new Map<number, string>();
  private readonly emittedDirs = new Set<number>();
  private nextDirHandle = 0;
  private readSource: Uint8Array | null = null;

  initialize(): Promise<{ version: number }> {
    return Promise.resolve({ version: this.version });
  }

  /** realpath 归一到绝对路径：已经是绝对路径的原样返回，否则拼到主目录下。 */
  realpath(path: string): Promise<string> {
    if (this.realpathError) return Promise.reject(this.realpathError);
    if (path === '.' || path === '' || path === '/') return Promise.resolve(this.realpathResult);
    if (path.startsWith('/')) return Promise.resolve(path);
    return Promise.resolve(`${this.realpathResult}/${path}`);
  }

  feed(chunk: Uint8Array): void {
    this.feeds.push(chunk);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  openDir(path: string): Promise<Uint8Array> {
    this.nextDirHandle += 1;
    const id = this.nextDirHandle;
    this.dirHandles.set(id, path);
    return Promise.resolve(new Uint8Array([(id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]));
  }

  readDir(handle: Uint8Array): Promise<FakeDirEntry[] | null> {
    const id = ((handle[0]! << 24) | (handle[1]! << 16) | (handle[2]! << 8) | handle[3]!) >>> 0;
    if (this.emittedDirs.has(id)) return Promise.resolve(null);
    this.emittedDirs.add(id);
    const path = this.dirHandles.get(id);
    const entries = (path === undefined ? undefined : this.tree.get(path)) ?? [];
    return Promise.resolve(entries.length > 0 ? entries : null);
  }

  closeHandle(handle: Uint8Array): Promise<void> {
    this.closedHandles.push(handle);
    return Promise.resolve();
  }

  stat(path: string): Promise<SFTPAttrs> {
    if (this.statError) return Promise.reject(this.statError);
    const known = this.stats.get(path);
    if (known) return Promise.resolve(known);
    const file = this.files.get(path);
    if (file) return Promise.resolve(fileAttrs(file.length));
    if (this.tree.has(path)) return Promise.resolve(dirAttrs());
    return Promise.reject(new Error(`no such file: ${path}`));
  }

  lstat(path: string): Promise<SFTPAttrs> {
    return this.stat(path);
  }

  openFile(path: string, flags: number): Promise<Uint8Array> {
    this.openedFiles.push({ path, flags });
    if (flags & SFTP_OPEN_FLAGS.READ) this.readSource = this.files.get(path) ?? new Uint8Array(0);
    return Promise.resolve(new Uint8Array([9, 9, 9, 9]));
  }

  readFile(_handle: Uint8Array, offset: number, length: number): Promise<Uint8Array | null> {
    if (this.readError) return Promise.reject(this.readError);
    const source = this.readSource;
    if (!source || offset >= source.length) return Promise.resolve(null);
    return Promise.resolve(source.subarray(offset, Math.min(offset + length, source.length)));
  }

  writeFile(_handle: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
    if (this.writeError) return Promise.reject(this.writeError);
    this.writes.push({ offset, length: data.length });
    return Promise.resolve();
  }

  removeFile(path: string): Promise<void> {
    this.removedFiles.push(path);
    return Promise.resolve();
  }

  mkdir(path: string): Promise<void> {
    this.createdDirs.push(path);
    return Promise.resolve();
  }

  rmdir(path: string): Promise<void> {
    this.removedDirs.push(path);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    this.renames.push({ from, to });
    return Promise.resolve();
  }
}
