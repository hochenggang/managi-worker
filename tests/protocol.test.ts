import { describe, expect, it } from 'vitest';
import {
  FLAG_END,
  HEADER_LEN,
  MAX_ENVELOPE_BYTES,
  MAX_FRAME_PAYLOAD,
  decodeEnvelope,
  decodeFrame,
  encodeFrame,
  requireChan,
  requirePath,
} from '../src/protocol';

/** 拼一个二进制帧的原始字节，用来喂给 decodeFrame。 */
function rawFrame(chan: number, flags: number, payload: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_LEN + payload.length);
  const view = new DataView(buffer);
  view.setUint32(0, chan);
  view.setUint16(4, flags);
  new Uint8Array(buffer, HEADER_LEN).set(payload);
  return buffer;
}

describe('encodeFrame / decodeFrame', () => {
  it('帧头是 6 字节：u32 通道号 + u16 标志位，大端', () => {
    const frame = encodeFrame(0x01020304, new Uint8Array([0xaa]));
    expect(Array.from(frame)).toEqual([0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0xaa]);
  });

  it('end=true 时置 FLAG_END', () => {
    const frame = encodeFrame(1, new Uint8Array(), true);
    expect(new DataView(frame.buffer).getUint16(4)).toBe(FLAG_END);
  });

  it('编码再解码能还原通道号、标志与正文', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const decoded = decodeFrame(encodeFrame(42, payload, true).buffer as ArrayBuffer);
    expect(decoded).not.toBeNull();
    expect(decoded!.chan).toBe(42);
    expect(decoded!.end).toBe(true);
    expect(Array.from(decoded!.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('正文为空也合法（FLAG_END 就是这样单独发的）', () => {
    const decoded = decodeFrame(encodeFrame(9, new Uint8Array(), true).buffer as ArrayBuffer);
    expect(decoded!.payload.byteLength).toBe(0);
    expect(decoded!.end).toBe(true);
  });

  it('标志位里有其它位时只认 FLAG_END', () => {
    const decoded = decodeFrame(rawFrame(3, 0xfff0, []));
    expect(decoded!.end).toBe(false);
    expect(decodeFrame(rawFrame(3, 0xfff1, []))!.end).toBe(true);
  });

  it('字节数不足帧头返回 null（字节流已错位，不能猜）', () => {
    expect(decodeFrame(new ArrayBuffer(0))).toBeNull();
    expect(decodeFrame(new ArrayBuffer(1))).toBeNull();
    expect(decodeFrame(new ArrayBuffer(HEADER_LEN - 1))).toBeNull();
  });

  it('恰好 6 字节：空正文，不是错误', () => {
    const decoded = decodeFrame(new ArrayBuffer(HEADER_LEN));
    expect(decoded).not.toBeNull();
    expect(decoded!.payload.byteLength).toBe(0);
  });

  it('通道号按无符号解析（高位为 1 时不能变成负数）', () => {
    expect(decodeFrame(rawFrame(0xffffffff, 0, []))!.chan).toBe(0xffffffff);
  });

  it('载荷超过上限直接拒绝（不让一个帧把内存吃光）', () => {
    const oversized = new ArrayBuffer(HEADER_LEN + MAX_FRAME_PAYLOAD + 1);
    expect(decodeFrame(oversized)).toBeNull();
    // 恰好到上限仍然接受
    expect(decodeFrame(new ArrayBuffer(HEADER_LEN + MAX_FRAME_PAYLOAD))).not.toBeNull();
  });
});

describe('decodeEnvelope', () => {
  it('正常控制帧原样返回', () => {
    expect(decodeEnvelope('{"type":"ping","seq":3}')).toEqual({ type: 'ping', seq: 3 });
  });

  it('data 是任意类型都透传', () => {
    expect(decodeEnvelope('{"type":"open","data":{"kind":"pty"}}')).toEqual({
      type: 'open',
      data: { kind: 'pty' },
    });
  });

  it('非法 JSON 返回 null，不抛', () => {
    expect(decodeEnvelope('这不是 JSON')).toBeNull();
    expect(decodeEnvelope('')).toBeNull();
    expect(decodeEnvelope('{')).toBeNull();
  });

  it('合法 JSON 但不是控制帧也返回 null', () => {
    expect(decodeEnvelope('null')).toBeNull();
    expect(decodeEnvelope('[]')).toBeNull();
    expect(decodeEnvelope('"字符串"')).toBeNull();
    expect(decodeEnvelope('42')).toBeNull();
    expect(decodeEnvelope('{"seq":1}')).toBeNull();
    expect(decodeEnvelope('{"type":123}')).toBeNull();
  });

  it('只保留 type / data / seq，多余字段不跟到后面去', () => {
    expect(decodeEnvelope('{"type":"ping","seq":1,"evil":"x"}')).toEqual({ type: 'ping', seq: 1 });
  });

  it('seq 必须是「非负整数」，其它形状一律拒绝', () => {
    expect(decodeEnvelope('{"type":"ping","seq":-1}')).toBeNull();
    expect(decodeEnvelope('{"type":"ping","seq":1.5}')).toBeNull();
    expect(decodeEnvelope('{"type":"ping","seq":"1"}')).toBeNull();
    expect(decodeEnvelope('{"type":"ping","seq":0}')).toEqual({ type: 'ping', seq: 0 });
  });

  it('type 为空串或过长时拒绝，超长正文也拒绝', () => {
    expect(decodeEnvelope('{"type":""}')).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: 'x'.repeat(65) }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: 'ping', pad: 'x'.repeat(MAX_ENVELOPE_BYTES) }))).toBeNull();
  });
});

describe('requireChan', () => {
  it('正整数通道号通过', () => {
    expect(requireChan({ chan: 1 })).toBe(1);
    expect(requireChan({ chan: 4294967295 })).toBe(4294967295);
  });

  it('缺失、零、负数、小数、字符串一律拒绝', () => {
    expect(() => requireChan({})).toThrow('chan 缺失或非法');
    expect(() => requireChan(undefined)).toThrow('chan 缺失或非法');
    expect(() => requireChan(null)).toThrow('chan 缺失或非法');
    expect(() => requireChan({ chan: 0 })).toThrow('chan 缺失或非法');
    expect(() => requireChan({ chan: -1 })).toThrow('chan 缺失或非法');
    expect(() => requireChan({ chan: 1.5 })).toThrow('chan 缺失或非法');
    expect(() => requireChan({ chan: '1' })).toThrow('chan 缺失或非法');
    expect(() => requireChan({ chan: Number.NaN })).toThrow('chan 缺失或非法');
  });
});

describe('requirePath', () => {
  it('非空字符串通过', () => {
    expect(requirePath({ path: '/tmp/a.txt' }, 'ls')).toBe('/tmp/a.txt');
  });

  it('错误文案带上动词，方便定位是哪条请求', () => {
    expect(() => requirePath({}, 'ls')).toThrow('ls: path 必填');
    expect(() => requirePath(undefined, 'rm')).toThrow('rm: path 必填');
  });

  it('空串与非字符串都拒绝', () => {
    expect(() => requirePath({ path: '' }, 'ls')).toThrow('ls: path 必填');
    expect(() => requirePath({ path: 42 }, 'ls')).toThrow('ls: path 必填');
    expect(() => requirePath({ path: null }, 'ls')).toThrow('ls: path 必填');
  });
});
