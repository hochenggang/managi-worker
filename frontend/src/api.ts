// API 客户端：HTTP 请求封装，含重试与超时。
// 修复 v2 缺陷：网络响应丢失（无重试）。设计见 design-v5.md §6.2。

import { useRetry } from '@/composables/useRetry'
import type { ApiNode, BatchCmdRequest, CmdsTestResult, OldApiNode } from '@/protocol/types'

const API_URI = {
  sshBatch: '/api/ssh/batch',
  sftpDownload: '/api/sftp/download',
} as const

/** getApiBase 推导当前部署的 HTTP API 基址（含协议+主机+端口）。
 *  WS 端点（composables/useWSHub.ts）也以此为基准推导，避免两处 host/port 逻辑漂移。
 */
export function getApiBase(): string {
  const stored = localStorage.getItem('managi-api-host')
  if (stored) return `${location.protocol}//${stored}`
  // https 保留非默认端口（修复 A8：部署在 8443 时丢端口）
  const port = location.port
  let host: string
  if (location.protocol === 'https:') {
    host = port && port !== '443' ? `${location.hostname}:${port}` : location.hostname
  } else {
    host = port ? `${location.hostname}:${port}` : location.hostname
  }
  return `${location.protocol}//${host}`
}

function getApiUrl(): string {
  return getApiBase()
}

const { withRetry } = useRetry()

/** readApiError 取后端 JSON 错误体里的具体原因（后端统一为 {"error": "..."}）。
 *  只有状态码时用户看不出是密码错了还是网络不通，故优先展示消息。
 */
async function readApiError(resp: Response): Promise<string> {
  try {
    const data = (await resp.json()) as { error?: string }
    if (data && typeof data.error === 'string' && data.error) return data.error
  } catch {
    // 非 JSON 响应（反向代理错误页等）：回退状态码
  }
  return `Error code ${resp.status}`
}

/** 带重试与超时的 fetch 封装。
 *  C3：AbortController 在每次重试的 fn 回调内创建，避免首次超时 abort 后重试复用已 aborted 的 signal。
 */
async function fetchWithRetry(url: string, body: unknown, timeoutMs = 30000): Promise<Response> {
  return withRetry(
    () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
    },
    { maxRetries: 3, baseDelay: 1000 },
  )
}

export async function batchSSH(nodes: ApiNode[], cmds: string[]): Promise<CmdsTestResult[]> {
  const req: BatchCmdRequest = { nodes, cmds }
  const resp = await fetchWithRetry(`${getApiUrl()}${API_URI.sshBatch}`, req)
  if (!resp.ok) throw new Error(await readApiError(resp))
  return resp.json()
}

// v3 新增：HTTP Range 下载（断点续传）。设计见 design-v5.md §6.5。
// 节点凭据走 POST body 而非 URL 查询串：URL 会被浏览器历史与各级访问日志记录。
// 续传偏移用 Range 请求头表达，不进入 URL。
export async function downloadWithRange(
  node: ApiNode,
  path: string,
  offset = 0,
): Promise<{ total: number; stream: ReadableStream<Uint8Array> }> {
  // 加 AbortController 超时，防止连接挂起时无限等待（仅控制首字节响应）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const resp = await fetch(`${getApiUrl()}${API_URI.sftpDownload}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Range: `bytes=${offset}-`,
      },
      body: JSON.stringify({ node, path }),
      signal: controller.signal,
    })
    if (!resp.ok && resp.status !== 206) throw new Error(await readApiError(resp))
    // body 可能为 null（服务端错误/网络中断），显式检查避免后续 getReader() 崩溃
    if (!resp.body) throw new Error('download: response body is null')
    const total = parseTotalFromRange(resp.headers.get('Content-Range') ?? '')
    return { total, stream: resp.body }
  } finally {
    clearTimeout(timer)
  }
}

export function parseTotalFromRange(range: string): number {
  // bytes 0-1023/2048 → 2048
  const m = range.match(/\/(\d+)/)
  return m ? parseInt(m[1]) : 0
}

// ===== 节点本地缓存（与 v2 一致）=====

export function getCachedNodes(): ApiNode[] {
  const raw = localStorage.getItem('cached-nodes')
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as (ApiNode | OldApiNode)[]
    return arr.map(oldApiNodeConvert)
  } catch {
    return []
  }
}

export function setCachedNodes(list: ApiNode[]): void {
  localStorage.setItem('cached-nodes', JSON.stringify(list))
}

export function oldApiNodeConvert(n: ApiNode | OldApiNode): ApiNode {
  if ('ip' in n) {
    return {
      name: n.name,
      host: n.ip,
      port: n.port,
      username: n.ssh_username,
      auth_type: n.auth_type,
      auth_value: n.auth_value,
      group: 'group' in n ? (n as unknown as ApiNode).group : undefined,
    }
  }
  return n
}

export function getCachedGroups(): string[] {
  const raw = localStorage.getItem('cached-groups')
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? (arr as string[]).filter((g) => typeof g === 'string') : []
  } catch {
    return []
  }
}

export function setCachedGroups(list: string[]): void {
  localStorage.setItem('cached-groups', JSON.stringify(list))
}
