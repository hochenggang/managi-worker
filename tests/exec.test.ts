import { describe, expect, it } from 'vitest';

import { ExecHandler } from '../src/handlers';
import type { SSHChannel } from '../src/ssh/channel';
import type { ChannelCallbacks, SSHConnection } from '../src/session';
import { FakeChannel, FakeConnection } from './fakes';

// exec 通道是「批量执行」的全部服务端逻辑：命令怎么发、两路输出怎么分、退出码怎么报。
// 这几件事错一件，用户看到的就是「看着成功其实失败」——所以逐条钉住。

interface Recorder {
  callbacks: ChannelCallbacks;
  data: Array<{ length: number; end: boolean; stderr: boolean }>;
  controls: Array<{ type: string; data?: unknown }>;
  errors: string[];
  ready: number;
  failed: string[];
}

function recorder(): Recorder {
  const rec: Recorder = {
    data: [],
    controls: [],
    errors: [],
    ready: 0,
    failed: [],
    callbacks: {
      data: (payload, end, stderr) => rec.data.push({ length: payload.length, end: end === true, stderr: stderr === true }),
      control: (envelope) => rec.controls.push(envelope),
      error: (message) => rec.errors.push(message),
      ready: () => { rec.ready += 1; },
      failed: (message) => rec.failed.push(message),
    },
  };
  return rec;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function make(command = 'uptime'): { handler: ExecHandler; rec: Recorder; channel: FakeChannel; conn: FakeConnection } {
  const conn = new FakeConnection();
  const rec = recorder();
  const handler = new ExecHandler(conn as unknown as SSHConnection, command, rec.callbacks);
  return { handler, rec, channel: conn.channel, conn };
}

describe('ExecHandler', () => {
  it('打开时发出 exec 请求（命令原样交给服务器，不自己拼 shell）', async () => {
    const { handler, channel } = make('df -h /');
    await handler.onOpened(channel as unknown as SSHChannel);
    expect(channel.requests).toEqual([{ name: 'exec', args: 'df -h /' }]);
  });

  it('服务器拒绝执行 → 报失败并关连接（不留一条只会挂着的通道）', async () => {
    const { handler, rec, conn, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(false);
    expect(rec.failed).toEqual(['服务器拒绝执行该命令']);
    expect(conn.closeCount).toBe(1);
  });

  it('stdout 与 stderr 各自带上标志，前端才能分栏', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.start();
    handler.onData(bytes('out'));
    handler.onExtendedData(bytes('err'));
    expect(rec.data).toEqual([
      { length: 3, end: false, stderr: false },
      { length: 3, end: false, stderr: true },
    ]);
  });

  it('响应写出之前的输出先攒着，start() 之后按原序放出', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.onData(bytes('first'));
    expect(rec.data).toEqual([]); // 闸门没开：这时候发出去前端会认不出通道
    handler.start();
    expect(rec.data).toEqual([{ length: 5, end: false, stderr: false }]);
  });

  it('退出码与「流结束」分成两个信号：命令失败 ≠ 通道坏了', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.start();
    handler.onExitStatus(3);
    handler.onClose();
    expect(rec.controls).toEqual([{
      type: 'exit',
      data: { code: 3, truncated_stdout: false, truncated_stderr: false },
    }]);
    expect(rec.data.at(-1)).toEqual({ length: 0, end: true, stderr: false });
    expect(rec.errors).toEqual([]); // 非零退出不是通道级错误
  });

  it('没有 exit-status（少数服务器）→ code 为 null，前端按「未知」展示', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.start();
    handler.onClose();
    expect(rec.controls[0]).toMatchObject({ data: { code: null } });
  });

  it('单路输出超过 4MB → 停止转发并标记截断（不截断会让 isolate 吃满内存）', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.start();
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 6; i += 1) handler.onData(chunk);
    const forwarded = rec.data.reduce((sum, item) => sum + item.length, 0);
    expect(forwarded).toBe(ExecHandler.MAX_STREAM_BYTES);

    handler.onClose();
    expect(rec.controls[0]).toMatchObject({ data: { truncated_stdout: true, truncated_stderr: false } });
  });

  it('两路各自独立计数：stdout 慢、stderr 正常时互不影响', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.start();
    const big = new Uint8Array(ExecHandler.MAX_STREAM_BYTES);
    handler.onData(big);
    handler.onExtendedData(bytes('still here'));
    expect(rec.data.at(-1)).toEqual({ length: 10, end: false, stderr: true });
  });

  it('关闭之后再来的数据不再转发（迟到的包不该写进已结束的通道）', async () => {
    const { handler, rec, channel } = make();
    await handler.onOpened(channel as unknown as SSHChannel);
    await handler.onRequestResult(true);
    handler.start();
    handler.onClose();
    const before = rec.data.length;
    handler.onData(bytes('late'));
    expect(rec.data).toHaveLength(before);
  });
});
