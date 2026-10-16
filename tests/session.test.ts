import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExecHandler,
  PTYHandler,
  SFTPHandler,
  SSHAuthDefectError,
  SSHConnection,
  describeConnectFailure,
  negotiateMac,
  type ChannelCallbacks,
  type ExecResult,
} from '../src/session';
import type { SSHChannel } from '../src/ssh/channel';
import type { SFTPAttrs } from '../src/ssh/sftp';
import {
  DIR_MODE,
  FILE_MODE,
  FakeChannel,
  FakeConnection,
  FakeSFTPClient,
  SYMLINK_MODE,
  attrs,
  dirAttrs,
  fileAttrs,
  symlinkAttrs,
} from './fakes';

// SFTPHandler 自己 new 出 SFTPClient，没有注入口，所以在这里换掉类本身，
// 把「怎么收发 SFTP 报文」交给协议栈的测试，本项目只验收编排逻辑。
const state = vi.hoisted(() => ({
  client: null as unknown,
  version: 3,
  realpathError: null as Error | null,
}));

vi.mock('../src/ssh/sftp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh/sftp')>();
  // 用动态 import 而不是引用顶层的静态导入：vi.mock 的工厂会被提升到所有 import 之前执行，
  // 那时顶层导入还处于 TDZ，直接引用会得到「Cannot access before initialization」。
  const { FakeSFTPClient } = await import('./fakes');
  class MockSFTPClient extends FakeSFTPClient {
    constructor() {
      super();
      this.version = state.version;
      this.realpathError = state.realpathError;
      state.client = this;
    }
  }
  return { ...actual, SFTPClient: MockSFTPClient };
});

// ===== 公共脚手架 =====

const conn = () => new FakeConnection();
const channel = (options?: ConstructorParameters<typeof FakeChannel>[0]) => new FakeChannel(options);
const asConn = (fake: FakeConnection) => fake as unknown as SSHConnection;
const asChannel = (fake: FakeChannel) => fake as unknown as SSHChannel;

interface CallbackRecorder {
  callbacks: ChannelCallbacks;
  data: Array<{ bytes: number; end: boolean }>;
  controls: Array<{ type: string; data?: unknown }>;
  errors: string[];
  ready: Array<string | undefined>;
  failed: string[];
}

function record(): CallbackRecorder {
  const recorder: CallbackRecorder = {
    data: [],
    controls: [],
    errors: [],
    ready: [],
    failed: [],
    callbacks: {
      data: (payload, end) => recorder.data.push({ bytes: payload.byteLength, end: end ?? false }),
      control: (envelope) => recorder.controls.push(envelope),
      error: (message) => recorder.errors.push(message),
      ready: (info) => recorder.ready.push(info),
      failed: (message) => recorder.failed.push(message),
    },
  };
  return recorder;
}

/** waitFor 轮询等待一个条件成立；比 sleep 固定时长更稳，也不引入假时钟。 */
async function waitFor(predicate: () => boolean, label = '条件', ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const text = (value: string) => new TextEncoder().encode(value);

/** 解析 SSH 报文里的「字符串」字段（4 字节长度 + 内容）。 */
function readField(bytes: Uint8Array, offset: number): { value: string; next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset);
  const value = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 4 + length));
  return { value, next: offset + 4 + length };
}

// ===== ExecHandler =====

describe('ExecHandler', () => {
  const CHANNEL_REQUEST = 98;

  function make(command: string, maxBytes = 4096) {
    const connection = conn();
    const results: ExecResult[] = [];
    const handler = new ExecHandler(asConn(connection), command, maxBytes, (result) => results.push(result));
    return { connection, results, handler };
  }

  it('打开通道时发出 exec 请求，通道号与命令都在报文里', async () => {
    const { connection, handler } = make('echo hi');
    const ch = channel({ remoteChannelID: 5 });
    await handler.onOpened(asChannel(ch));

    const payload = connection.sentEncrypted[0]!;
    expect(payload[0]).toBe(CHANNEL_REQUEST);
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(1)).toBe(5);
    const name = readField(payload, 5);
    expect(name.value).toBe('exec');
    expect(payload[name.next]).toBe(0x01); // want-reply
    expect(readField(payload, name.next + 1).value).toBe('echo hi');
  });

  it('允许换行的命令 —— 批量命令正是「多行脚本在同一个 shell 里顺序跑」', async () => {
    const { connection, handler } = make('cd /tmp\nls -la\nexit 0');
    await handler.onOpened(asChannel(channel()));
    const payload = connection.sentEncrypted[0]!;
    const name = readField(payload, 5);
    expect(readField(payload, name.next + 1).value).toBe('cd /tmp\nls -la\nexit 0');
  });

  it('空命令直接拒绝', async () => {
    const { handler } = make('');
    await expect(handler.onOpened(asChannel(channel()))).rejects.toThrow('执行命令为空');
  });

  it('超过 64KB 的命令拒绝', async () => {
    const { handler } = make('x'.repeat(64 * 1024 + 1));
    await expect(handler.onOpened(asChannel(channel()))).rejects.toThrow('执行命令过长');
  });

  it('收集 stdout / stderr 与退出码，通道关闭时了结', async () => {
    const { results, handler } = make('cmd');
    handler.onData(text('第一行\n第二行\n'));
    handler.onExtendedData(text('警告\n'));
    handler.onExitStatus(3);
    handler.onClose();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      stdout: '第一行\n第二行\n',
      stderr: '警告\n',
      exitStatus: 3,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('只了结一次（onClose 之后再来的都没用）', () => {
    const { results, handler } = make('cmd');
    handler.onClose();
    handler.onOpenFailure('服务器拒绝了 exec 请求');
    expect(results).toHaveLength(1);
  });

  it('exec 请求被拒时把原因写进 stderr', () => {
    const { results, handler } = make('cmd');
    handler.onOpenFailure('服务器拒绝了 exec 请求');
    expect(results[0]!.stderr).toBe('服务器拒绝了 exec 请求');
    expect(results[0]!.exitStatus).toBeNull();
  });

  it('onRequestResult(false) 也当作请求被拒', async () => {
    const { results, handler } = make('cmd');
    await handler.onRequestResult(false);
    expect(results[0]!.stderr).toBe('服务器拒绝了 exec 请求');
  });

  it('onEof 不提前了结（还要等 CLOSE 才知道输出收完了）', () => {
    const { results, handler } = make('cmd');
    handler.onData(text('partial'));
    handler.onEof();
    expect(results).toHaveLength(0);
    handler.onClose();
    expect(results[0]!.stdout).toBe('partial');
  });

  it('stdout 超过上限时截断并标记（提示由调用方补，不混进 error）', () => {
    const { results, handler } = make('cmd', 10);
    handler.onData(new Uint8Array(4));
    handler.onData(new Uint8Array(100));
    handler.onClose();
    expect(results[0]!.stdoutTruncated).toBe(true);
    expect(results[0]!.stderrTruncated).toBe(false);
  });

  it('stderr 超过上限时独立截断（两条流各有各的额度）', () => {
    const { results, handler } = make('cmd', 5);
    handler.onData(text('stdout 部分'));
    handler.onExtendedData(text('stderr 部分'));
    handler.onClose();
    expect(results[0]!.stdoutTruncated).toBe(true);
    expect(results[0]!.stderrTruncated).toBe(true);
    expect(results[0]!.stdout).toBe('stdou');
    expect(results[0]!.stderr.length).toBeGreaterThan(0);
  });

  it('已超限之后继续来的数据不再累加，只是重复标记', () => {
    const { results, handler } = make('cmd', 3);
    handler.onData(text('abc'));
    handler.onData(text('def'));
    handler.onClose();
    expect(results[0]!.stdout).toBe('abc');
  });

  it('多字节字符被分片切断时能正确拼回（stdout 与 stderr 各留各的半个）', () => {
    const { results, handler } = make('cmd');
    const emoji = text('😀'); // 4 字节
    handler.onData(emoji.subarray(0, 2));
    handler.onExtendedData(text('err'));
    handler.onData(emoji.subarray(2));
    handler.onClose();
    expect(results[0]!.stdout).toBe('😀');
    expect(results[0]!.stderr).toBe('err');
  });

  it('onExitStatus 可以在 onClose 之前任意时刻到达', () => {
    const { results, handler } = make('cmd');
    handler.onClose();
    expect(results[0]!.exitStatus).toBeNull();

    const second = make('cmd');
    second.handler.onExitStatus(0);
    second.handler.onWindowAdjust();
    second.handler.onClose();
    expect(second.results[0]!.exitStatus).toBe(0);
  });
});

// ===== PTYHandler =====

describe('PTYHandler', () => {
  const cb = () => record();

  it('打开时申请 pty-req，尺寸与终端类型都在里面', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 120, 40, rec.callbacks);
    const ch = channel();
    await handler.onOpened(asChannel(ch));
    expect(ch.requests[0]).toEqual({ name: 'pty-req', args: '120x40:xterm-256color' });
  });

  it('pty 被拒时上报失败并关掉连接（一路通道一条连接，留着没意义）', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    await handler.onRequestResult(false);
    expect(rec.failed).toEqual(['服务器拒绝了 PTY 请求']);
    expect(connection.closeCount).toBe(1);
  });

  it('pty 通过后申请 shell，shell 通过才算就绪', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    const ch = channel();
    await handler.onOpened(asChannel(ch));
    await handler.onRequestResult(true);
    expect(ch.requests[1]).toEqual({ name: 'shell', args: '' });
    expect(rec.ready).toHaveLength(0);
    await handler.onRequestResult(true);
    expect(rec.ready).toHaveLength(1);
  });

  it('shell 被拒时只上报失败，不关连接（报文里可能还有解释）', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    await handler.onRequestResult(true);
    await handler.onRequestResult(false);
    expect(rec.failed).toEqual(['服务器拒绝了 shell 请求']);
    expect(connection.closeCount).toBe(0);
  });

  it('首帧输出就代表 shell 起来了（有些服务器不回 CHANNEL_SUCCESS）', () => {
    const rec = cb();
    const handler = new PTYHandler(asConn(conn()), 80, 24, rec.callbacks);
    handler.onData(text('$ '));
    expect(rec.ready).toHaveLength(1);
    expect(rec.data).toEqual([{ bytes: 2, end: false }]);
  });

  it('就绪只上报一次', () => {
    const rec = cb();
    const handler = new PTYHandler(asConn(conn()), 80, 24, rec.callbacks);
    handler.onData(text('a'));
    handler.onData(text('b'));
    handler.onEof();
    expect(rec.ready).toHaveLength(1);
  });

  it('单次输出超过 32KB 时拆成多帧（前端一帧一帧渲染）', () => {
    const rec = cb();
    const handler = new PTYHandler(asConn(conn()), 80, 24, rec.callbacks);
    handler.onData(new Uint8Array(PTYHandler.OUT_FRAME * 2 + 5));
    expect(rec.data).toEqual([
      { bytes: PTYHandler.OUT_FRAME, end: false },
      { bytes: PTYHandler.OUT_FRAME, end: false },
      { bytes: 5, end: false },
    ]);
  });

  it('stderr 也当输出喂给终端（PTY 下通常已合并，真收到也不能丢）', () => {
    const rec = cb();
    const handler = new PTYHandler(asConn(conn()), 80, 24, rec.callbacks);
    handler.onExtendedData(text('oops'));
    expect(rec.data).toEqual([{ bytes: 4, end: false }]);
  });

  it('通道关闭时补一个空的结束帧，且只补一次', () => {
    const rec = cb();
    const handler = new PTYHandler(asConn(conn()), 80, 24, rec.callbacks);
    handler.onClose();
    handler.onClose();
    expect(rec.data).toEqual([{ bytes: 0, end: true }]);
  });

  it('关掉之后的输入被丢弃（不再往已死的通道里写）', () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    handler.onClose();
    handler.queueInput(text('late'));
    expect(connection.channelData).toEqual([]);
  });

  it('打开失败时上报失败原因', () => {
    const rec = cb();
    const handler = new PTYHandler(asConn(conn()), 80, 24, rec.callbacks);
    handler.onOpenFailure('通道开不了');
    expect(rec.failed).toEqual(['通道开不了']);
  });

  it('输入按到达顺序发出，并累计回 ack 推进前端窗口', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    await handler.onOpened(asChannel(connection.channel));
    handler.queueInput(text('abc'));
    handler.queueInput(text('de'));
    await waitFor(() => connection.channelData.length === 2, '两片输入发完');
    expect(connection.channelData).toEqual([3, 2]);
    expect(rec.controls).toEqual([
      { type: 'ack', data: { bytes: 3 } },
      { type: 'ack', data: { bytes: 5 } },
    ]);
  });

  it('远端窗口用尽时停下，收到 WINDOW_ADJUST 再从断点续发', async () => {
    const connection = conn();
    const limited = channel({ window: 4 });
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    await handler.onOpened(asChannel(limited));

    handler.queueInput(new Uint8Array(10));
    await waitFor(() => connection.channelData.length === 1, '第一片');
    expect(connection.channelData).toEqual([4]);

    limited.grantWindow(100);
    handler.onWindowAdjust();
    await waitFor(() => connection.channelData.length === 2, '续发剩下的');
    expect(connection.channelData).toEqual([4, 6]);
    expect(rec.controls.at(-1)).toEqual({ type: 'ack', data: { bytes: 10 } });
  });

  it('发送失败时把错误报出来（不静默挂死）', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    await handler.onOpened(asChannel(connection.channel));
    vi.spyOn(connection, 'sendChannelData').mockRejectedValue(new Error('通道断了'));
    handler.queueInput(text('x'));
    await waitFor(() => rec.errors.length === 1, '错误上报');
    expect(rec.errors[0]).toContain('通道断了');
  });

  it('通道刚建立、还没就绪时来的输入不会丢（排队，就绪时自动带出去）', async () => {
    const connection = conn();
    const rec = cb();
    const handler = new PTYHandler(asConn(connection), 80, 24, rec.callbacks);
    handler.queueInput(text('early'));
    await handler.onOpened(asChannel(connection.channel));
    expect(connection.channelData).toEqual([]);
    await handler.onRequestResult(true);
    await handler.onRequestResult(true); // 就绪 → flush 把排队的输入带出去
    await waitFor(() => connection.channelData.length === 1, '补发排队输入');
    expect(connection.channelData).toEqual([5]);
  });
});

// ===== SFTPHandler =====

describe('SFTPHandler', () => {
  let client: FakeSFTPClient;

  /** ready 一个 SFTPHandler：走完 onOpened + 子系统请求通过，拿到注入的假客户端。 */
  async function ready(rec = record(), ch = channel()) {
    const connection = conn();
    const handler = new SFTPHandler(asConn(connection), rec.callbacks);
    await handler.onOpened(asChannel(ch));
    await handler.onRequestResult(true);
    client = state.client as FakeSFTPClient;
    return { connection, handler, rec, ch };
  }

  beforeEach(() => {
    state.client = null;
    state.version = 3;
    state.realpathError = null;
  });

  it('打开时申请 sftp 子系统', async () => {
    const rec = record();
    const ch = channel();
    const connection = conn();
    const handler = new SFTPHandler(asConn(connection), rec.callbacks);
    await handler.onOpened(asChannel(ch));
    expect(ch.requests[0]).toEqual({ name: 'subsystem', args: 'sftp' });
    expect(connection.sentEncrypted).toHaveLength(1);
  });

  it('子系统被拒时上报失败', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    await handler.onRequestResult(false);
    expect(rec.failed).toEqual(['服务器拒绝了 SFTP 子系统']);
  });

  it('SFTP 版本不是 3 时拒绝（文件语义会不一样）', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    state.version = 4;
    await handler.onRequestResult(true);
    expect(rec.failed).toEqual(['不支持的 SFTP 版本 4']);
    expect(rec.ready).toEqual([]);
  });

  it('就绪时把 realpath 得到的主目录报上去', async () => {
    const rec = record();
    await ready(rec);
    expect(rec.ready).toEqual(['/home/tester']);
  });

  it('取不到主目录时退回根（不能因为一次 realpath 失败就整体失败）', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    state.realpathError = new Error('服务器不支持 realpath');
    await handler.onRequestResult(true);
    expect(rec.failed).toEqual([]);
    expect(rec.ready).toEqual(['/']);
  });

  it('列目录：结果路径用 realpath 归一，跳过 . 与 ..', async () => {
    const { handler } = await ready();
    client.tree.set('/opt', [
      { filename: '.', attrs: dirAttrs() },
      { filename: '..', attrs: dirAttrs() },
      { filename: 'a.txt', attrs: fileAttrs(3) },
      { filename: 'sub', attrs: dirAttrs() },
    ]);
    const result = await handler.list('/opt');
    expect(result.path).toBe('/opt');
    expect(result.files.map((file) => file.filename)).toEqual(['a.txt', 'sub']);
    expect(result.files[0]).toEqual({ filename: 'a.txt', size: 3, mode: '-rw-r--r--', is_dir: false, mtime: 0 });
    expect(result.files[1]!.is_dir).toBe(true);
    expect(client.closedHandles).toHaveLength(1);
  });

  it('列空目录给出空列表', async () => {
    const { handler } = await ready();
    client.tree.set('/empty', []);
    await expect(handler.list('/empty')).resolves.toEqual({ path: '/empty', files: [] });
  });

  it('列目录时路径不能为空', async () => {
    const { handler } = await ready();
    await expect(handler.list('')).rejects.toThrow('路径不能为空');
  });

  it('列目录时取出所有条目（. 与 .. 不算）', async () => {
    const { handler } = await ready();
    client.tree.set('/x', [
      { filename: '.', attrs: dirAttrs() },
      { filename: '..', attrs: dirAttrs() },
      { filename: '1', attrs: fileAttrs(1) },
      { filename: '2', attrs: fileAttrs(2) },
    ]);
    const result = await handler.list('/x');
    expect(result.files.map((file) => file.filename)).toEqual(['1', '2']);
  });

  it('mkdir -p：绝对路径逐级创建，已存在的层级跳过', async () => {
    const { handler } = await ready();
    client.stats.set('/a', dirAttrs());
    await handler.mkdir('/a/b/c');
    expect(client.createdDirs).toEqual(['/a/b', '/a/b/c']);
  });

  it('mkdir 相对路径：已存在就什么都不做，不存在才建', async () => {
    const { handler } = await ready();
    client.stats.set('exists', dirAttrs());
    await handler.mkdir('exists');
    expect(client.createdDirs).toEqual([]);
    await handler.mkdir('fresh');
    expect(client.createdDirs).toEqual(['fresh']);
  });

  it('mkdir 路径为空时拒绝', async () => {
    const { handler } = await ready();
    await expect(handler.mkdir('')).rejects.toThrow('mkdir: path 必填');
  });

  it('rm 普通文件：直接删', async () => {
    const { handler } = await ready();
    client.stats.set('/tmp/a.txt', fileAttrs(1));
    await handler.remove('/tmp/a.txt');
    expect(client.removedFiles).toEqual(['/tmp/a.txt']);
    expect(client.removedDirs).toEqual([]);
  });

  it('rm 软链接：只删链接本身，绝不顺着链接递归进去', async () => {
    const { handler } = await ready();
    client.stats.set('/tmp/link', symlinkAttrs());
    await handler.remove('/tmp/link');
    expect(client.removedFiles).toEqual(['/tmp/link']);
    expect(client.removedDirs).toEqual([]);
  });

  it('rm 目录：递归删到底再删目录', async () => {
    const { handler } = await ready();
    client.stats.set('/data', dirAttrs());
    client.tree.set('/data', [
      { filename: 'f1', attrs: fileAttrs(1) },
      { filename: 'nested', attrs: dirAttrs() },
    ]);
    client.tree.set('/data/nested', [{ filename: 'f2', attrs: fileAttrs(2) }]);
    await handler.remove('/data');
    expect(client.removedFiles.sort()).toEqual(['/data/f1', '/data/nested/f2']);
    expect(client.removedDirs).toEqual(['/data/nested', '/data']);
  });

  it('rm 遇到带软链接的目录：链接只删链接，不进目标', async () => {
    const { handler } = await ready();
    client.tree.set('/data', [{ filename: 'shortcut', attrs: symlinkAttrs() }]);
    client.stats.set('/data', dirAttrs());
    await handler.remove('/data');
    expect(client.removedFiles).toEqual(['/data/shortcut']);
    expect(client.removedDirs).toEqual(['/data']);
  });

  it('rm 路径为空时拒绝', async () => {
    const { handler } = await ready();
    await expect(handler.remove('')).rejects.toThrow('rm: path 必填');
  });

  it('rm 在 lstat 不可用时退回 stat（老服务器可能不支持 LSTAT）', async () => {
    const { handler } = await ready();
    client.stats.set('/tmp/x', fileAttrs(1));
    vi.spyOn(client, 'lstat').mockRejectedValue(new Error('LSTAT 不支持'));
    await handler.remove('/tmp/x');
    expect(client.removedFiles).toEqual(['/tmp/x']);
  });

  it('上传：文件名不能带路径分隔符，也不能是 . / ..', async () => {
    const { handler } = await ready();
    await expect(handler.beginUpload('/d', 'a/b', 1, 1)).rejects.toThrow('非法文件名');
    await expect(handler.beginUpload('/d', 'a\\b', 1, 1)).rejects.toThrow('非法文件名');
    await expect(handler.beginUpload('/d', '.', 1, 1)).rejects.toThrow('非法文件名');
    await expect(handler.beginUpload('/d', '..', 1, 1)).rejects.toThrow('非法文件名');
    await expect(handler.beginUpload('/d', '', 1, 1)).rejects.toThrow('非法文件名');
  });

  it('上传：没有声明的总大小时不做尺寸校验（chunked 上传场景）', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    const info = await handler.beginUpload('', 'f.bin', 0, 0);
    await handler.writeData(new Uint8Array(5));
    await expect(handler.finishUpload()).resolves.toBe(5);
    expect(client.renames).toEqual([{ from: 'f.bin.0-0.part', to: 'f.bin' }]);
  });

  it('上传：新文件从 0 开始，并按身份命名残片', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    const info = await handler.beginUpload('', 'f.bin', 100, 42);
    expect(info).toEqual({ offset: 0, chunk_size: SFTPHandler.CHUNK_SIZE });
    expect(client.openedFiles[0]).toEqual({ path: 'f.bin.100-42.part', flags: expect.any(Number) });
  });

  it('上传：同身份残片存在时从它的长度续传', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    client.stats.set('f.bin.100-42.part', fileAttrs(30));
    const info = await handler.beginUpload('', 'f.bin', 100, 42);
    expect(info.offset).toBe(30);
  });

  it('上传：残片比声明的还大说明被外部动过，身份不可信，重传', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    client.stats.set('f.bin.100-42.part', fileAttrs(500));
    const info = await handler.beginUpload('', 'f.bin', 100, 42);
    expect(info.offset).toBe(0);
    expect(client.removedFiles).toContain('f.bin.100-42.part');
  });

  it('上传：清掉同名目标的陈旧残片，但保留本次身份那一个', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    client.stats.set('./f.bin.100-42.part', fileAttrs(30));
    client.tree.set('.', [
      { filename: 'f.bin.part', attrs: fileAttrs(9) },
      { filename: 'f.bin.55-11.part', attrs: fileAttrs(9) },
      { filename: 'f.bin.100-42.part', attrs: fileAttrs(30) },
      { filename: 'other.part', attrs: fileAttrs(9) },
      { filename: 'f.bin.notanidentity.part', attrs: fileAttrs(9) },
    ]);
    await handler.beginUpload('', 'f.bin', 100, 42);
    expect(client.removedFiles.sort()).toEqual(['f.bin.55-11.part', 'f.bin.part']);
  });

  it('上传：写数据按偏移累加并回 ack', async () => {
    const { handler, rec } = await ready();
    client.stats.set('.', dirAttrs());
    await handler.beginUpload('', 'f.bin', 10, 1);
    await handler.writeData(new Uint8Array(4));
    await handler.writeData(new Uint8Array(6));
    expect(client.writes).toEqual([{ offset: 0, length: 4 }, { offset: 4, length: 6 }]);
    expect(rec.controls).toEqual([
      { type: 'ack', data: { bytes: 4 } },
      { type: 'ack', data: { bytes: 10 } },
    ]);
  });

  it('上传：分片总量超过声明大小时中止，不留一个「大小对、内容错」的文件', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    await handler.beginUpload('', 'f.bin', 5, 1);
    await expect(handler.writeData(new Uint8Array(6))).rejects.toThrow('分片超出声明的文件大小');
    await expect(handler.writeData(new Uint8Array(1))).rejects.toThrow('当前通道没有进行中的上传');
  });

  it('上传：写入失败时中止但保留残片（下次还能续）', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    await handler.beginUpload('', 'f.bin', 10, 1);
    // 清掉 beginUpload 期间（列目录清残片）顺手关掉的句柄，只看这次失败导致的关闭。
    client.closedHandles.length = 0;
    client.writeError = new Error('磁盘满了');
    await expect(handler.writeData(new Uint8Array(4))).rejects.toThrow('磁盘满了');
    expect(client.closedHandles).toHaveLength(1);
    expect(client.writes).toEqual([]);
  });

  it('上传：finish 时大小对不上就报错，不改名', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    await handler.beginUpload('', 'f.bin', 10, 1);
    client.stats.set('f.bin.10-1.part', fileAttrs(4));
    await handler.writeData(new Uint8Array(4));
    await expect(handler.finishUpload()).rejects.toThrow('上传未完成');
    expect(client.renames).toEqual([]);
  });

  it('上传：finish 大小吻合时改名落定，返回实际写入字节数', async () => {
    const { handler } = await ready();
    client.stats.set('.', dirAttrs());
    await handler.beginUpload('', 'f.bin', 4, 1);
    client.stats.set('f.bin.4-1.part', fileAttrs(4));
    await handler.writeData(new Uint8Array(4));
    await expect(handler.finishUpload()).resolves.toBe(4);
    expect(client.renames).toEqual([{ from: 'f.bin.4-1.part', to: 'f.bin' }]);
  });

  it('上传：没有进行中的上传时写数据 / 收尾都报错', async () => {
    const { handler } = await ready();
    await expect(handler.writeData(new Uint8Array(1))).rejects.toThrow('当前通道没有进行中的上传');
    await expect(handler.finishUpload()).rejects.toThrow('当前通道没有进行中的上传');
  });

  it('上传：目标目录不存在时先建出来', async () => {
    const { handler } = await ready();
    client.stats.set('/target', dirAttrs());
    await handler.beginUpload('/target', 'f.bin', 1, 1);
    expect(client.openedFiles[0]!.path).toBe('/target/f.bin.1-1.part');
  });

  it('下载：文件名取自路径末段，总大小来自 stat', async () => {
    const { handler } = await ready();
    client.files.set('/tmp/report.csv', new Uint8Array(10));
    const download = await handler.download('/tmp/report.csv');
    expect(download.filename).toBe('report.csv');
    expect(download.total).toBe(10);
  });

  it('下载：路径里没有任何名字段时退回默认文件名', async () => {
    const { handler } = await ready();
    client.stats.set('/', attrs({ size: 1, permissions: FILE_MODE }));
    const download = await handler.download('/');
    expect(download.filename).toBe('download');
  });

  it('下载：拿不到大小时明确报错', async () => {
    const { handler } = await ready();
    client.stats.set('/tmp/weird', attrs({ permissions: FILE_MODE }));
    await expect(handler.download('/tmp/weird')).rejects.toThrow('无法读取远端文件大小');
  });

  it('下载：start() 之后把整份内容推出去，末尾补一个结束帧', async () => {
    const { handler, rec } = await ready();
    client.files.set('/tmp/f.bin', new Uint8Array(10));
    const download = await handler.download('/tmp/f.bin');
    download.start();
    await waitFor(() => rec.data.some((item) => item.end), '下载结束帧');
    expect(rec.data.slice(0, -1).map((item) => item.bytes)).toEqual([10]);
    expect(rec.data.at(-1)).toEqual({ bytes: 0, end: true });
    expect(rec.errors).toEqual([]);
  });

  it('下载：给了起始偏移就从该偏移推（HTTP Range 续传，不是先读后丢）', async () => {
    const { handler, rec } = await ready();
    client.files.set('/tmp/f.bin', new Uint8Array(10));
    const download = await handler.download('/tmp/f.bin', 4);
    expect(download.total).toBe(10);
    download.start();
    await waitFor(() => rec.data.some((item) => item.end), '续传结束帧');
    expect(rec.data[0]!.bytes).toBe(6);
  });

  it('下载：偏移超出文件大小时从文件尾开始（等于一个空响应）', async () => {
    const { handler, rec } = await ready();
    client.files.set('/tmp/f.bin', new Uint8Array(4));
    const download = await handler.download('/tmp/f.bin', 999);
    download.start();
    await waitFor(() => rec.data.some((item) => item.end), '空下载结束帧');
    expect(rec.data).toEqual([{ bytes: 0, end: true }]);
  });

  it('下载：负数偏移归零', async () => {
    const { handler } = await ready();
    client.files.set('/tmp/f.bin', new Uint8Array(4));
    const download = await handler.download('/tmp/f.bin', -5);
    expect(download.total).toBe(4);
  });

  it('下载：读失败时报错但**不补结束帧**（前端据此判失败，而不是当着传完了）', async () => {
    const { handler, rec } = await ready();
    client.files.set('/tmp/f.bin', new Uint8Array(10));
    client.readError = new Error('连接断了');
    const download = await handler.download('/tmp/f.bin');
    download.start();
    await waitFor(() => rec.errors.length > 0, '下载错误');
    expect(rec.errors[0]).toContain('download:');
    expect(rec.errors[0]).toContain('连接断了');
    expect(rec.data.every((item) => !item.end)).toBe(true);
  });

  it('下载：同一通道同时只允许一个下载', async () => {
    const { handler } = await ready();
    client.files.set('/tmp/f.bin', new Uint8Array(10));
    await handler.download('/tmp/f.bin');
    await expect(handler.download('/tmp/f.bin')).rejects.toThrow('本通道已有下载在进行');
  });

  it('下载：通道还没就绪时拒绝（客户端只在子系统握手成功后才存在）', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    await expect(handler.download('/x')).rejects.toThrow('SFTP 会话不可用');
  });

  it('收到数据就喂给协议客户端', async () => {
    const { handler } = await ready();
    handler.onData(new Uint8Array([1, 2, 3]));
    expect(client.feeds).toHaveLength(1);
  });

  it('喂数据时客户端抛错就上报并销毁会话', async () => {
    const { handler, rec } = await ready();
    vi.spyOn(client, 'feed').mockImplementation(() => { throw new Error('报文损坏'); });
    handler.onData(new Uint8Array([1]));
    expect(rec.errors).toEqual(['报文损坏']);
    await expect(handler.list('/x')).rejects.toThrow('SFTP 会话不可用');
  });

  it('扩展数据（stderr）转成错误文案并截断到 512 字符', async () => {
    const { handler, rec } = await ready();
    handler.onExtendedData(text(`  ${'x'.repeat(600)}  `));
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]).toHaveLength(512);
  });

  it('扩展数据为空时什么都不报', async () => {
    const { handler, rec } = await ready();
    handler.onExtendedData(text('   '));
    expect(rec.errors).toEqual([]);
  });

  it('通道关闭时销毁会话并补结束帧', async () => {
    const { handler, rec } = await ready();
    handler.onClose();
    expect(client.disposeCalls).toBe(1);
    expect(rec.data).toEqual([{ bytes: 0, end: true }]);
  });

  it('打开失败时上报原因', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    handler.onOpenFailure('通道开不了');
    expect(rec.failed).toEqual(['通道开不了']);
  });

  it('dispose 可重复调用（连接关闭与子系统关闭会各来一次）', async () => {
    const { handler } = await ready();
    handler.dispose();
    handler.dispose();
    expect(client.disposeCalls).toBe(1);
  });

  it('销毁后所有目录操作都明确报「会话不可用」', async () => {
    const { handler } = await ready();
    handler.dispose();
    await expect(handler.list('/x')).rejects.toThrow('SFTP 会话不可用');
    await expect(handler.mkdir('/x')).rejects.toThrow('SFTP 会话不可用');
    await expect(handler.remove('/x')).rejects.toThrow('SFTP 会话不可用');
    await expect(handler.beginUpload('/d', 'f', 1, 1)).rejects.toThrow('SFTP 会话不可用');
  });
});

// ===== 失败文案 =====

describe('describeConnectFailure', () => {
  it('普通错误带上 主机:端口 前缀，方便一眼看出是哪台机器', () => {
    expect(describeConnectFailure(new Error('TCP 连接超时'), 'example.com', 2222))
      .toBe('example.com:2222 — TCP 连接超时');
  });

  it('主机名两边的空格不会漏进文案', () => {
    expect(describeConnectFailure(new Error('boom'), '  example.com  ', 22)).toBe('example.com:22 — boom');
  });

  it('凭据 / 主机信任被拒时原样输出（原因已经说清楚了）', () => {
    const error = new SSHAuthDefectError('SSH 认证失败：用户名、密码或私钥不正确');
    expect(describeConnectFailure(error, 'example.com', 22)).toBe('SSH 认证失败：用户名、密码或私钥不正确');
  });

  it('私钥本身有问题时补一句可操作的提示', () => {
    const message = describeConnectFailure(new Error('无法解析 private key'), 'example.com', 22);
    expect(message).toContain('仅支持未加密的 OpenSSH 格式私钥');
  });

  it('认证失败的文案里也含「私钥」二字，但不该被补成私钥格式问题', () => {
    const message = describeConnectFailure(new Error('SSH 认证失败：用户名、密码或私钥不正确'), 'a.com', 22);
    expect(message).toBe('a.com:22 — SSH 认证失败：用户名、密码或私钥不正确');
  });

  it('非 Error 抛出物也能出文案', () => {
    expect(describeConnectFailure('纯字符串错误', 'a.com', 22)).toBe('a.com:22 — 纯字符串错误');
  });
});

// ===== 与协议栈的边界 =====

describe('SSHConnection 的对外契约', () => {
  it('未握手时拒绝开通道（防止在还没加密的连接上发业务数据）', () => {
    const connection = new SSHConnection(
      {} as Socket,
      {
        host: 'h', port: 22, username: 'u', authMethod: 'password',
        password: 'p', cols: 80, rows: 24, term: 'xterm-256color',
      },
      { ended: () => undefined, verifyHostKey: async () => ({ ok: true }) },
    );
    expect(connection.isReady()).toBe(false);
    expect(() => connection.openExec(new ExecHandler(connection, 'x', 10, () => undefined)))
      .toThrow('SSH 连接尚未就绪');
  });

  it('close 之后重复 close 不抛（通道关闭与 WS 断开都会调）', () => {
    const connection = new SSHConnection(
      { close: () => undefined } as unknown as Socket,
      {
        host: 'h', port: 22, username: 'u', authMethod: 'password',
        password: 'p', cols: 80, rows: 24, term: 'xterm-256color',
      },
      { ended: () => undefined, verifyHostKey: async () => ({ ok: true }) },
    );
    expect(() => { connection.close(); connection.close(); }).not.toThrow();
  });

  it('resizePTY 在通道未知时静默返回（前端会在挂载时先发一次）', () => {
    const connection = new SSHConnection(
      { close: () => undefined } as unknown as Socket,
      {
        host: 'h', port: 22, username: 'u', authMethod: 'password',
        password: 'p', cols: 80, rows: 24, term: 'xterm-256color',
      },
      { ended: () => undefined, verifyHostKey: async () => ({ ok: true }) },
    );
    expect(() => connection.resizePTY(42, 100, 30)).not.toThrow();
    expect(() => connection.closeChannel(42)).not.toThrow();
  });
});

describe('文件属性渲染的边界（经由 list 观察）', () => {
  it('没有权限位时 mode 用问号占位，size 缺失按 0', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    state.client = null;
    await handler.onRequestResult(true);
    const fake = state.client as FakeSFTPClient;
    fake.tree.set('/x', [{ filename: 'mystery', attrs: attrs({}) }]);
    const result = await handler.list('/x');
    expect(result.files[0]).toEqual({
      filename: 'mystery', size: 0, mode: '??????????', is_dir: false, mtime: 0,
    });
  });

  it('目录标记为 is_dir，大小按可读值给出', async () => {
    const rec = record();
    const handler = new SFTPHandler(asConn(conn()), rec.callbacks);
    await handler.onOpened(asChannel(channel()));
    await handler.onRequestResult(true);
    const fake = state.client as FakeSFTPClient;
    fake.tree.set('/x', [
      { filename: 'd', attrs: attrs({ permissions: DIR_MODE, mtime: 99 }) },
      { filename: 'l', attrs: attrs({ permissions: SYMLINK_MODE, size: '5' }) as SFTPAttrs },
      { filename: 'f', attrs: attrs({ permissions: FILE_MODE, size: 42 }) },
    ]);
    const result = await handler.list('/x');
    expect(result.files).toEqual([
      { filename: 'd', size: 0, mode: 'drwxr-xr-x', is_dir: true, mtime: 99 },
      { filename: 'l', size: 5, mode: 'lrwxrwxrwx', is_dir: false, mtime: 0 },
      { filename: 'f', size: 42, mode: '-rw-r--r--', is_dir: false, mtime: 0 },
    ]);
  });
});

// 这条修的是「假失败」：服务器给 aes*-gcm（AEAD），但它的 MAC 列表与我们不相交。
// 上游 EdgeSSH 无条件协商 MAC —— 于是报 No common MAC，而正确行为是按规范跳过协商直接连通。
// 下面两组列表直接取自真实服务器（185.82.202.216:10010）的 KEXINIT。
describe('negotiateMac：AEAD 下必须跳过 MAC 协商', () => {
  const OUR_MACS = ['hmac-sha2-256', 'hmac-sha2-512'];
  const SERVER_MACS = ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com'];

  it('AEAD 密码 + MAC 完全无交集 → 返回 none，不抛错', () => {
    expect(negotiateMac(OUR_MACS, SERVER_MACS, '客户端 MAC', 'aes128-gcm@openssh.com')).toBe('none');
  });

  it('反向（服务端加密）同样跳过', () => {
    expect(negotiateMac(OUR_MACS, SERVER_MACS, '服务端 MAC', 'aes256-gcm@openssh.com')).toBe('none');
  });

  it('AEAD 下即使 MAC 有交集也返回 none —— AEAD 根本不消费这个结果', () => {
    expect(negotiateMac(OUR_MACS, OUR_MACS, '客户端 MAC', 'aes128-gcm@openssh.com')).toBe('none');
  });

  it('非 AEAD 且无交集 → 仍然如实报错，不静默降级', () => {
    expect(() => negotiateMac(OUR_MACS, SERVER_MACS, '客户端 MAC', 'aes256-ctr')).toThrow(/No common 客户端 MAC/);
  });

  it('非 AEAD 的报错要带上已选加密算法 —— 否则分不清是服务器没给可用 MAC', () => {
    expect(() => negotiateMac(OUR_MACS, SERVER_MACS, '客户端 MAC', 'aes256-ctr'))
      .toThrow(/加密算法已选 aes256-ctr，不是 AEAD，MAC 必须协商成功/);
  });

  it('非 AEAD 且 MAC 有交集 → 按客户端偏好顺序选，不跟服务器顺序', () => {
    expect(negotiateMac(['hmac-sha2-512', 'hmac-sha2-256'], ['hmac-sha2-256', 'hmac-sha2-512'], '客户端 MAC', 'aes128-ctr'))
      .toBe('hmac-sha2-512');
  });

  it('加密算法名不认识时直接抛错，不会被当成 AEAD 蒙过去', () => {
    expect(() => negotiateMac(OUR_MACS, OUR_MACS, '客户端 MAC', 'aes128-cbc')).toThrow(/Unsupported cipher/);
  });
});
