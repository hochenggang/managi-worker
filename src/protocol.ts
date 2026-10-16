// managi 的前后端协议，逐字段对齐前端的 frontend/src/protocol/{ws,frames,sftp}.ts。
//
//  控制面（文本帧）  {type, data, seq}  一问一答靠 seq 关联，seq=0 表示不等回复或服务端主动推。
//  数据面（二进制帧）[chan: u32 BE][flags: u16 BE][原始字节]
//
// 前端一行都没改，所以这里的动词、字段名、帧头布局都不能自作主张。

/** 通道种类：一路终端标签，或一路文件管理标签。 */
export type Kind = 'pty' | 'sftp';

export type Verb =
  | 'open'
  | 'close'
  | 'resize'
  | 'ping'
  | 'pong'
  | 'error'
  | 'ack'
  | 'ls'
  | 'mkdir'
  | 'rm'
  | 'upload'
  | 'upload_end'
  | 'download';

export interface Envelope {
  type: string;
  data?: unknown;
  seq?: number;
}

/** 远程节点描述。与前端 protocol/types.ts 的 ApiNode 一致。 */
export interface ApiNode {
  name?: string;
  host: string;
  port: number;
  username: string;
  auth_type?: 'password' | 'key';
  auth_value?: string;
  group?: string;
}

/** 目录项。size/mtime 是 int64，JS number 在 2^53 内精确。 */
export interface FileItem {
  filename: string;
  size: number;
  mode: string;
  is_dir: boolean;
  mtime: number;
}

export interface CmdsTestResult {
  time_elapsed: number;
  success: boolean;
  output: string[];
  error: string[];
  node: ApiNode;
  cmds: string;
}

// ===== 数据面 =====

export const HEADER_LEN = 6;
export const FLAG_END = 0x0001;

export interface DataFrame {
  chan: number;
  end: boolean;
  payload: Uint8Array;
}

/** decodeFrame 解析一个二进制帧；长度不足帧头返回 null（字节流已错位）。 */
export function decodeFrame(buf: ArrayBuffer): DataFrame | null {
  if (buf.byteLength < HEADER_LEN) return null;
  const view = new DataView(buf);
  return {
    chan: view.getUint32(0),
    end: (view.getUint16(4) & FLAG_END) !== 0,
    payload: new Uint8Array(buf, HEADER_LEN),
  };
}

/** encodeFrame 组装一帧，返回可直接 ws.send() 的字节。 */
export function encodeFrame(chan: number, payload: Uint8Array, end = false): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, chan);
  view.setUint16(4, end ? FLAG_END : 0);
  out.set(payload, HEADER_LEN);
  return out;
}

/** decodeEnvelope 解析控制帧；不是本协议的 JSON 返回 null。 */
export function decodeEnvelope(text: string): Envelope | null {
  try {
    const obj = JSON.parse(text) as Envelope;
    return typeof obj?.type === 'string' ? obj : null;
  } catch {
    return null;
  }
}

/** 通道号统一解析：前端一律把 chan 塞在 data 里。 */
export function requireChan(data: unknown): number {
  const chan = (data as { chan?: unknown } | undefined)?.chan;
  if (typeof chan !== 'number' || !Number.isInteger(chan) || chan <= 0) {
    throw new Error('chan 缺失或非法');
  }
  return chan;
}

export function requirePath(data: unknown, verb: string): string {
  const path = (data as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string' || path === '') throw new Error(`${verb}: path 必填`);
  return path;
}
