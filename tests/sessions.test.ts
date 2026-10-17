import { afterEach, describe, expect, it, vi } from 'vitest';

import { RingBuffer, safeCut } from '../src/ring';
import { TerminalSession, nodeKeyOf, type TerminalSink } from '../src/sessions';
import type { SSHConnection } from '../src/session';
import { FakeConnection } from './fakes';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('RingBuffer', () => {
  it('超过上限时丢头部，保留最近的字节', () => {
    const ring = new RingBuffer(8);
    ring.append(bytes('abcdef'));
    ring.append(bytes('ghij'));
    expect(new TextDecoder().decode(ring.snapshot())).toBe('cdefghij');
  });

  it('截断点落在多字节字符中间时，往后推到字符起始处', () => {
    // 「中」是 3 字节。两个「中」共 6 字节，容量 4 → 切点在第 2 字节（续字节）上。
    const ring = new RingBuffer(4);
    ring.append(bytes('中中'));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(ring.snapshot());
    expect(text).toBe('中');
  });

  it('safeCut 在纯 ASCII（或恰好对齐）时原样返回', () => {
    const data = bytes('abcdef');
    expect(safeCut(data, 2)).toBe(2);
    expect(safeCut(data, 0)).toBe(0);
    expect(safeCut(data, 99)).toBe(6);
  });

  it('snapshot 是副本：调用方改了不会污染缓冲', () => {
    const ring = new RingBuffer(16);
    ring.append(bytes('abc'));
    ring.snapshot()[0] = 0x7a;
    expect(new TextDecoder().decode(ring.snapshot())).toBe('abc');
  });
});

interface SinkRecord {
  sink: TerminalSink;
  data: Array<{ text: string; end: boolean }>;
  controls: Array<{ type: string; data?: unknown }>;
  errors: string[];
}

function sink(chan = 1): SinkRecord {
  const rec: SinkRecord = {
    data: [],
    controls: [],
    errors: [],
    sink: {
      chan,
      data: (payload, end) => rec.data.push({ text: new TextDecoder().decode(payload), end: end === true }),
      control: (envelope) => rec.controls.push(envelope),
      error: (message) => rec.errors.push(message),
    },
  };
  return rec;
}

function make(): { session: TerminalSession; conn: FakeConnection; gone: TerminalSession[] } {
  const conn = new FakeConnection();
  const gone: TerminalSession[] = [];
  const session = new TerminalSession('tab-1', 'h:22:root', conn as unknown as SSHConnection, (s) => gone.push(s));
  return { session, conn, gone };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalSession', () => {
  it('挂起期间只进 scrollback，release 时先回放再放实时输出', () => {
    const { session } = make();
    const first = sink(1);
    session.attach(first.sink);
    session.push(bytes('history'));
    expect(first.data).toEqual([]); // 闸门没开：前端还不认识这个 chan

    session.release();
    expect(first.data).toEqual([{ text: 'history', end: false }]);

    session.push(bytes('live'));
    expect(first.data.at(-1)).toEqual({ text: 'live', end: false });
  });

  it('detach 之后输出继续进 scrollback；attach 到新通道时整份回放', () => {
    const { session, conn } = make();
    const first = sink(1);
    session.attach(first.sink);
    session.release();
    session.push(bytes('before'));
    session.detach();
    expect(conn.closeCount).toBe(0);

    session.push(bytes('-after'));

    // 换一条「新连接上的新通道号」重连
    const second = sink(9);
    session.attach(second.sink);
    session.release();
    expect(second.data).toEqual([{ text: 'before-after', end: false }]);
  });

  it('空闲超时 → 关连接并从注册表摘除（幂等）', () => {
    vi.useFakeTimers();
    const { session, conn, gone } = make();
    session.attach(sink().sink);
    session.release();
    session.detach();

    vi.advanceTimersByTime(TerminalSession.IDLE_TTL_MS);
    expect(conn.closeCount).toBe(1);
    expect(gone).toHaveLength(1);

    session.dispose('再来一次');
    expect(conn.closeCount).toBe(1); // 幂等：不会重复关
  });

  it('通道结束（end）→ 会话立即回收，不留一个已经死掉的 shell', () => {
    const { session, conn, gone } = make();
    const s = sink();
    session.attach(s.sink);
    session.release();
    session.push(bytes('bye'), true);
    expect(s.data.at(-1)).toEqual({ text: 'bye', end: true });
    expect(conn.closeCount).toBe(1);
    expect(gone).toHaveLength(1);
  });

  it('重连会取消空闲计时：不会在用户正用着的时候把会话关掉', () => {
    vi.useFakeTimers();
    const { session, conn } = make();
    session.attach(sink().sink);
    session.release();
    session.detach();
    vi.advanceTimersByTime(TerminalSession.IDLE_TTL_MS - 1);

    session.attach(sink(2).sink);
    session.release();
    vi.advanceTimersByTime(TerminalSession.IDLE_TTL_MS * 2);
    expect(conn.closeCount).toBe(0);
  });
});

describe('nodeKeyOf', () => {
  it('主机名大小写与首尾空白归一（否则同一个节点会被当成两个）', () => {
    expect(nodeKeyOf({ host: ' Example.COM ', port: 22, username: 'root' }))
      .toBe(nodeKeyOf({ host: 'example.com', port: 22, username: 'root' }));
  });

  it('端口或用户名不同就是不同节点', () => {
    expect(nodeKeyOf({ host: 'a', port: 22, username: 'root' }))
      .not.toBe(nodeKeyOf({ host: 'a', port: 2222, username: 'root' }));
    expect(nodeKeyOf({ host: 'a', port: 22, username: 'root' }))
      .not.toBe(nodeKeyOf({ host: 'a', port: 22, username: 'other' }));
  });
});
