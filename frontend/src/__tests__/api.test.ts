import { describe, it, expect, beforeEach } from 'vitest'
import { oldApiNodeConvert, getCachedNodes, setCachedNodes } from '@/api'
import type { ApiNode, OldApiNode } from '@/protocol/types'

describe('oldApiNodeConvert', () => {
  it('converts old format (ip/ssh_username) to new format (host/username)', () => {
    const old: OldApiNode = {
      name: 'old',
      ip: '1.2.3.4',
      port: 22,
      ssh_username: 'root',
      auth_type: 'password',
      auth_value: 'pass',
    }
    const converted = oldApiNodeConvert(old)
    expect(converted.host).toBe('1.2.3.4')
    expect(converted.username).toBe('root')
    expect(converted.name).toBe('old')
    expect(converted.port).toBe(22)
    expect(converted.auth_type).toBe('password')
    expect(converted.auth_value).toBe('pass')
  })

  it('passes through new format unchanged', () => {
    const node: ApiNode = {
      name: 'new',
      host: '5.6.7.8',
      port: 22,
      username: 'admin',
      auth_type: 'key',
      auth_value: 'keydata',
    }
    expect(oldApiNodeConvert(node)).toEqual(node)
  })
})

describe('getCachedNodes / setCachedNodes', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty array when no cache', () => {
    expect(getCachedNodes()).toEqual([])
  })

  it('returns empty array for invalid JSON', () => {
    localStorage.setItem('cached-nodes', 'not json')
    expect(getCachedNodes()).toEqual([])
  })

  it('roundtrips nodes through cache', () => {
    const nodes: ApiNode[] = [
      {
        name: 'n1',
        host: '1.2.3.4',
        port: 22,
        username: 'root',
        auth_type: 'password',
        auth_value: 'pass',
      },
    ]
    setCachedNodes(nodes)
    expect(getCachedNodes()).toEqual(nodes)
  })

  it('converts old format nodes from cache', () => {
    const oldNodes: OldApiNode[] = [
      {
        name: 'old',
        ip: '1.2.3.4',
        port: 22,
        ssh_username: 'root',
        auth_type: 'password',
        auth_value: 'pass',
      },
    ]
    localStorage.setItem('cached-nodes', JSON.stringify(oldNodes))
    const result = getCachedNodes()
    expect(result).toHaveLength(1)
    expect(result[0].host).toBe('1.2.3.4')
    expect(result[0].username).toBe('root')
  })
})
