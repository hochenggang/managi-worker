// 协议层：集中定义所有 WebSocket 与 HTTP 消息类型。
// 取代 v2 散落在组件内的隐式约定，与后端 internal/model/types.go 对齐。
// 设计见 design-v5.md §5.2.1。

/** 节点：远程 SSH 服务器描述（与 v2 typeApiNode 兼容）。 */
export interface ApiNode {
  name: string
  host: string
  port: number
  username: string
  auth_type: 'password' | 'key'
  auth_value: string
  group?: string
}

/** 旧版节点格式（兼容迁移用）。 */
export interface OldApiNode {
  name: string
  ip: string
  port: number
  ssh_username: string
  auth_type: 'password' | 'key'
  auth_value: string
}

/** 单节点命令执行结果。 */
export interface CmdsTestResult {
  time_elapsed: number
  success: boolean
  output: string[]
  error: string[]
  node: ApiNode
  cmds: string
}

/** 批量命令请求体。 */
export interface BatchCmdRequest {
  nodes: ApiNode[]
  cmds: string[]
}

/** 快捷命令项。 */
export interface ShortcutItem {
  label: string
  cmd: string
}

/** 应用配置文件（v3），导出/导入时使用。 */
export interface AppConfig {
  version: 3
  nodes: Record<string, ApiNode>
  groups: string[]
  shortcuts: ShortcutItem[]
  settings?: Partial<import('@/stores/settingsStore').Settings>
}

/** 节点唯一 ID：host:port:username。
 *  与后端连接池键（model.ConnectionKey）保持一致：同主机同端口但不同用户名的节点
 *  是不同节点，若 ID 不含 username 会在前端互相覆盖、静默丢数据。
 */
export function generateNodeId(node: ApiNode): string {
  return `${node.host}:${node.port}:${node.username}`
}

/** 会话身份键：generateNodeId + 凭据指纹。
 *  后端连接池键同样含凭据指纹——同 host:port:username 但密码/私钥不同
 *  （改过口令的条目与旧条目并存）必须是互不复用的两条会话，
 *  否则会沿用别人（或旧口令）建立的连接。
 *  此键只用于标签判重、会话缓存等瞬时状态；分组等持久化数据仍用
 *  generateNodeId，否则改一次凭据就会打散用户已存好的分组。
 */
export function nodeSessionKey(node: ApiNode): string {
  return `${generateNodeId(node)}:${authFingerprint(node)}`
}

// authFingerprint 认证材料的 FNV-1a 32 位摘要：仅用于区分身份，不承载安全语义。
function authFingerprint(node: ApiNode): string {
  const text = `${node.auth_type}\u0000${node.auth_value}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}
