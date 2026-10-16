import { describe, it, expect } from 'vitest'
import { generateNodeId, nodeSessionKey, type ApiNode } from './types'

describe('generateNodeId', () => {
  const base: ApiNode = {
    name: 'test',
    host: '',
    port: 0,
    username: 'root',
    auth_type: 'password',
    auth_value: 'pass',
  }

  it('returns host:port:username format', () => {
    expect(generateNodeId({ ...base, host: '1.2.3.4', port: 22 })).toBe('1.2.3.4:22:root')
  })

  it('returns host:port:username for different port', () => {
    expect(generateNodeId({ ...base, host: 'example.com', port: 18001 })).toBe('example.com:18001:root')
  })

  it('is consistent for same node', () => {
    const node = { ...base, host: '10.0.0.1', port: 2222 }
    expect(generateNodeId(node)).toBe(generateNodeId(node))
  })

  it('distinguishes same host:port with different usernames', () => {
    // 同主机同端口但不同用户名是不同节点，ID 必须不同，否则会互相覆盖
    const a = { ...base, host: '10.0.0.1', port: 22, username: 'root' }
    const b = { ...base, host: '10.0.0.1', port: 22, username: 'deploy' }
    expect(generateNodeId(a)).not.toBe(generateNodeId(b))
  })

  // 节点名可随意改，ID 只由身份信息决定
  it('ignores name (renaming must not change identity)', () => {
    const node = { ...base, host: '10.0.0.1', port: 22 }
    expect(generateNodeId({ ...node, name: 'old' })).toBe(generateNodeId({ ...node, name: 'new' }))
  })
})

// generateNodeId 不含凭据（持久化分组依赖它）；会话/标签判重必须用 nodeSessionKey，
// 否则改了密码的节点会复用旧标签或旧 sessionId，连到错误凭据。
describe('nodeSessionKey', () => {
  const base: ApiNode = {
    name: 'test',
    host: '1.2.3.4',
    port: 22,
    username: 'root',
    auth_type: 'password',
    auth_value: 'pass',
  }

  it('starts with generateNodeId and is stable for the same node', () => {
    const key = nodeSessionKey(base)
    expect(key.startsWith(generateNodeId(base))).toBe(true)
    expect(key).toBe(nodeSessionKey({ ...base }))
  })

  it('distinguishes different passwords on the same host:port:username', () => {
    expect(nodeSessionKey({ ...base, auth_value: 'old' })).not.toBe(nodeSessionKey({ ...base, auth_value: 'new' }))
  })

  it('distinguishes key auth from password auth with identical auth_value', () => {
    const password = { ...base, auth_type: 'password' as const }
    const key = { ...base, auth_type: 'key' as const }
    expect(nodeSessionKey(password)).not.toBe(nodeSessionKey(key))
  })

  it('does not leak the credential into the key', () => {
    expect(nodeSessionKey({ ...base, auth_value: 'super-secret' })).not.toContain('super-secret')
  })
})
