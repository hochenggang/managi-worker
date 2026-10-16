import { describe, it, expect } from 'vitest'
import { FLAG_END, HEADER_LEN, decodeFrame, encodeFrame, splitBytes } from './frames'

// 数据面帧头是大端 [chan: u32][flags: u16]，与后端 internal/wire/frame.go 逐字节对齐。
// 这里把字节序钉死：改成小端或漏掉一个字节都会静默产出错乱文件，只有断言能拦住。

describe('encodeFrame', () => {
  it('writes big-endian chan + flags before the payload', () => {
    const f = encodeFrame(0x0102, new Uint8Array([0x41, 0x42]))
    expect([...f]).toEqual([0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x41, 0x42])
  })

  it('sets the END flag bit without touching the payload', () => {
    const f = encodeFrame(7, new Uint8Array([0xff]), true)
    expect(f).toHaveLength(HEADER_LEN + 1)
    expect(new DataView(f.buffer).getUint16(4)).toBe(FLAG_END)
    expect(f[HEADER_LEN]).toBe(0xff)
  })

  it('encodes an empty end frame (upload 落定信号)', () => {
    const f = encodeFrame(3, new Uint8Array(0), true)
    expect(f).toHaveLength(HEADER_LEN)
    expect(decodeFrame(f.buffer)).toEqual({ chan: 3, end: true, payload: new Uint8Array(0) })
  })
})

describe('decodeFrame', () => {
  it('round-trips every field', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const decoded = decodeFrame(encodeFrame(258, payload, true).buffer)
    expect(decoded?.chan).toBe(258)
    expect(decoded?.end).toBe(true)
    expect([...(decoded?.payload ?? [])]).toEqual([1, 2, 3, 4, 5])
  })

  it('returns null for a buffer shorter than the header', () => {
    expect(decodeFrame(new Uint8Array([0, 0, 0]).buffer)).toBeNull()
    expect(decodeFrame(new ArrayBuffer(0))).toBeNull()
  })

  it('views the payload instead of copying it', () => {
    const buf = encodeFrame(1, new Uint8Array([9, 9])).buffer
    const decoded = decodeFrame(buf)!
    expect(decoded.payload.buffer).toBe(buf)
    expect(decoded.payload.byteOffset).toBe(HEADER_LEN)
  })

  it('只认 END 位，未知标志位不影响判定', () => {
    const out = encodeFrame(1, new Uint8Array([0]))
    new DataView(out.buffer).setUint16(4, FLAG_END | 0x8000)
    expect(decodeFrame(out.buffer)?.end).toBe(true)
    new DataView(out.buffer).setUint16(4, 0x8000)
    expect(decodeFrame(out.buffer)?.end).toBe(false)
  })
})

describe('splitBytes', () => {
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i)

  it('空输入不分片', () => {
    expect(splitBytes(new Uint8Array(0), 4)).toEqual([])
  })

  it('保持顺序且总字节数不变', () => {
    const data = bytes(10)
    const parts = splitBytes(data, 4)
    expect(parts.map((p) => p.byteLength)).toEqual([4, 4, 2])
    const merged = new Uint8Array(data.byteLength)
    let offset = 0
    for (const p of parts) {
      merged.set(p, offset)
      offset += p.byteLength
    }
    expect([...merged]).toEqual([...data])
  })

  it('整除时不留空尾片', () => {
    expect(splitBytes(bytes(8), 4).map((p) => p.byteLength)).toEqual([4, 4])
  })

  it('钳制下限：max<=0 也不能产出 0 字节步长（否则循环永不结束）', () => {
    expect(splitBytes(bytes(3), 0).map((p) => p.byteLength)).toEqual([1, 1, 1])
    expect(splitBytes(bytes(2), -5).map((p) => p.byteLength)).toEqual([1, 1])
    expect(splitBytes(bytes(5), 2.9).map((p) => p.byteLength)).toEqual([2, 2, 1])
  })

  it('分片是视图：不复制，粘贴大文本不翻倍占内存', () => {
    const data = bytes(8)
    expect(splitBytes(data, 4)[1].buffer).toBe(data.buffer)
  })
})
