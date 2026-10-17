// API 客户端：部署基址推导 + 节点本地缓存。
//
// 这里没有 fetch：终端与文件收发全部走 /ws 一条 WebSocket。
// HTTP 上只剩 /api/version 这个探针，前端不调它 —— 它是部署排障时手敲的。

import type { ApiNode, OldApiNode } from '@/protocol/types'

/** getApiBase 推导当前部署的基址（含协议+主机+端口）。
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
