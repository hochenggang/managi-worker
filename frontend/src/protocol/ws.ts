// 控制面协议：一条 /ws 连接上的 JSON 文本帧 {type, data, seq}。
// 与后端 handler/wsmsg.go、handler/ws.go 的动词与负载逐字段对齐。
// 一问一答靠 seq 关联；seq 省略（=0）表示不等回复或服务端主动推。

import type { ApiNode } from './types'

/** 通道种类：一路终端标签，或一路文件管理标签。 */
export type Kind = 'pty' | 'sftp'

/** 控制面动词。 */
export type Verb =
  // 通道生命周期
  | 'open'
  | 'close'
  | 'resize'
  // 心跳、错误与流控
  | 'ping'
  | 'pong'
  | 'error'
  | 'ack'
  // SFTP 目录操作
  | 'ls'
  | 'mkdir'
  | 'rm'
  // SFTP 字节流（内容走数据面二进制帧）
  | 'upload'
  | 'upload_end'
  | 'download'

/** 控制面信封。 */
export interface Envelope<T = unknown> {
  type: Verb
  data?: T
  seq?: number
}

/** error 负载：chan 省略或为 0 表示与具体通道无关。 */
export interface ErrorData {
  chan?: number
  message: string
}

/** ack 负载：服务端确认本通道输入流「已消费或已作废」的累计字节数。
 *  枢纽据此滑动发送窗口（见 useWSHub.waitAck），业务层看不到这个动词。 */
export interface AckData {
  chan: number
  bytes: number
}

/** open 响应负载。
 *  home：sftp 子系统的初始目录（通常为主目录），无根目录读权限的账号据此起步。
 *  chunk_size：客户端→服务端单帧载荷上限，仅 PTY 下发；上传的切片大小随 upload 响应给。
 *  window：输入窗口字节数（两类通道都下发），上传与粘贴按它节流发送。
 */
export interface OpenResponse {
  kind: Kind
  chan: number
  reattached?: boolean
  home?: string
  chunk_size?: number
  window?: number
}

/** open 请求负载。PTY 靠 session_id 复用后端 shell；SFTP 只需节点描述。 */
export interface OpenPTY {
  kind: 'pty'
  node: ApiNode
  session_id: string
  cols: number
  rows: number
}

export interface OpenSFTP {
  kind: 'sftp'
  node: ApiNode
}

export type OpenPayload = OpenPTY | OpenSFTP

/** 目录/传输类请求负载：通道号由枢纽统一注入，调用方只写业务字段。 */
export type RequestData = Record<string, unknown>

export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify(env)
}

/** decodeEnvelope 解析控制帧；不是本协议的 JSON 返回 null（调用方丢弃，避免渲染垃圾）。 */
export function decodeEnvelope(text: string): Envelope | null {
  try {
    const obj = JSON.parse(text) as Envelope
    return typeof obj.type === 'string' ? obj : null
  } catch {
    return null
  }
}
