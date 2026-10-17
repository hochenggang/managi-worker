// SFTP 客户端的「异常时序」验收：迟到的应答、重复的应答、真正陌生的请求号。
//
// 为什么单独一组：这三件事都只在**慢服务器**上出现，而它们的代价完全不对等——
// 忽略一个多余应答什么都不会坏；把它当成协议错误，整条 SFTP 通道会被 dispose，
// 前端看到的是文件管理页报废。

import { describe, expect, it } from 'vitest';
import {
  SFTPClient,
  SFTPProtocolError,
  SFTPTimeoutError,
  SFTP_PACKET_TYPES,
} from '../src/ssh/sftp';

// ===== 造报文 =====

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function string(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat([u32(bytes.length), bytes]);
}

/** packet 拼出「长度前缀 + 类型 + 字段」的一个完整报文，与 feed() 的入参同构。 */
function packet(type: number, ...fields: Uint8Array[]): Uint8Array {
  const body = concat([new Uint8Array([type]), ...fields]);
  return concat([u32(body.length), body]);
}

/** readRequestId 从发出去的报文里取出请求号。布局：[长度 4][类型 1][请求号 4]… */
function readRequestId(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset + 5, 4).getUint32(0, false);
}

// ===== 脚手架 =====

interface Harness {
  client: SFTPClient;
  /** 客户端写出去的报文（已带长度前缀）。 */
  sent: Uint8Array[];
}

async function ready(options: { initialRequestId?: number; requestTimeoutMs?: number } = {}): Promise<Harness> {
  const sent: Uint8Array[] = [];
  const client = new SFTPClient(
    (data) => { sent.push(data); return Promise.resolve(); },
    { requestTimeoutMs: options.requestTimeoutMs ?? 20, ...(options.initialRequestId ? { initialRequestId: options.initialRequestId } : {}) },
  );
  const initialized = client.initialize();
  // 服务端第一句永远是 VERSION。
  client.feed(packet(SFTP_PACKET_TYPES.VERSION, u32(3)));
  await initialized;
  return { client, sent };
}

const attrsOk = (id: number): Uint8Array => packet(SFTP_PACKET_TYPES.ATTRS, u32(id), u32(0));

// ===== 用例 =====

describe('SFTP 客户端的迟到应答', () => {
  it('超时之后才到的应答被丢弃，不当成协议错误', async () => {
    const { client, sent } = await ready({ initialRequestId: 7, requestTimeoutMs: 5 });
    const pending = client.stat('/a');
    await expect(pending).rejects.toBeInstanceOf(SFTPTimeoutError);

    const id = readRequestId(sent[1]!);
    expect(id).toBe(7);
    // 以前这里会抛 "unknown request ID"，整条通道跟着废掉
    expect(() => client.feed(attrsOk(id))).not.toThrow();

    // 通道仍然可用：下一次请求照常一问一答
    const second = client.stat('/b');
    const nextId = readRequestId(sent[2]!);
    client.feed(attrsOk(nextId));
    await expect(second).resolves.toMatchObject({ flags: 0 });
  });

  it('重复的应答同样只丢弃（服务器重发不该毁掉整条通道）', async () => {
    const { client, sent } = await ready();
    const pending = client.stat('/a');
    const id = readRequestId(sent[1]!);
    client.feed(attrsOk(id));
    await expect(pending).resolves.toBeDefined();

    expect(() => client.feed(attrsOk(id))).not.toThrow();
  });

  it('真正陌生的请求号仍然是协议错误（不能把垃圾一起咽下去）', async () => {
    const { client } = await ready();
    const pending = client.stat('/a');
    // 这个号从来没被分配过：字节流已经错位，继续往下读只会更错
    expect(() => client.feed(attrsOk(4242))).toThrow(SFTPProtocolError);
    await expect(pending).rejects.toBeInstanceOf(SFTPProtocolError);
  });
});
