// 数据面协议：二进制帧 [chan: u32 大端][flags: u16 大端][原始字节]。
// 与后端 internal/wire/frame.go 逐字节对齐。
// 字节不经过 JSON：PTY 输出与文件分片保持原样，跨帧边界的半个 UTF-8 字符也不会变成 U+FFFD。

export const HEADER_LEN = 6

/** FLAG_END 该通道上这路数据流到此结束（下载的最后一片、上传的「写完请落定」）。载荷可为空。 */
export const FLAG_END = 0x0001

export interface DataFrame {
  chan: number
  end: boolean
  /** payload 是接收缓冲的视图，不拷贝。 */
  payload: Uint8Array
}

/** decodeFrame 解析一个二进制帧。长度不足帧头返回 null——字节流已错位，这条连接不可再用。 */
export function decodeFrame(buf: ArrayBuffer): DataFrame | null {
  if (buf.byteLength < HEADER_LEN) return null
  const view = new DataView(buf)
  return {
    chan: view.getUint32(0),
    end: (view.getUint16(4) & FLAG_END) !== 0,
    payload: new Uint8Array(buf, HEADER_LEN),
  }
}

/** encodeFrame 组装一帧，返回可直接 ws.send() 的字节。 */
export function encodeFrame(chan: number, payload: Uint8Array, end = false): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, chan)
  view.setUint16(4, end ? FLAG_END : 0)
  out.set(payload, HEADER_LEN)
  return out
}

/** splitBytes 把字节流切成不超过 max 的片段，保持顺序；空输入不分片。
 *  切点落在多字节字符中间无所谓：PTY stdin 按到达顺序拼接字节，重组后仍是原字节。
 *  max 下限钳到 1，否则循环永不结束（调用方传错参数表现为页面卡死而不是报错）。
 */
export function splitBytes(data: Uint8Array, max: number): Uint8Array[] {
  if (data.byteLength === 0) return []
  const limit = Math.max(1, Math.floor(max))
  const parts: Uint8Array[] = []
  for (let pos = 0; pos < data.byteLength; pos += limit) {
    parts.push(data.subarray(pos, pos + limit))
  }
  return parts
}
