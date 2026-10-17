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
/** 单帧载荷上限。上传分片 64KB、终端输出 32KB，1MB 已经远超任何合规客户端。 */
export const MAX_FRAME_PAYLOAD = 1 << 20;
/** 控制帧上限：合法报文都是几百字节，64KB 已经足够宽松。 */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

export interface DataFrame {
  chan: number;
  end: boolean;
  payload: Uint8Array;
}

/**
 * decodeFrame 解析一个二进制帧；帧头都凑不齐就返回 null（字节流已错位）。
 *
 * 这里补的校验只有载荷长度：以前任意大的帧都能进来，一路 memcpy 到业务层。
 * 未定义的标志位按 RFC 精神忽略（只认 FLAG_END），这样以后加标志不必先升服务端。
 */
export function decodeFrame(buf: ArrayBuffer): DataFrame | null {
  if (buf.byteLength < HEADER_LEN) return null;
  if (buf.byteLength - HEADER_LEN > MAX_FRAME_PAYLOAD) return null;
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

/**
 * decodeEnvelope 解析控制帧；不是本协议的 JSON 返回 null。
 *
 * 只挑出 type / data / seq 三个字段，而不是把整个对象透传：
 * 调用方拿到的必须是我们认得的形状，多余字段没有理由跟到后面去。
 */
export function decodeEnvelope(text: string): Envelope | null {
  if (text.length > MAX_ENVELOPE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || type === '' || type.length > 64) return null;
  const seq = record.seq;
  if (seq !== undefined && (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)) return null;
  return { type, data: record.data, seq: seq as number | undefined };
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
