import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  downloadWithRange,
  parseTotalFromRange,
  oldApiNodeConvert,
  getCachedNodes,
  setCachedNodes,
} from '@/api'
import type { ApiNode, OldApiNode } from '@/protocol/types'

const nodeWithSecret: ApiNode = {
  name: 'n',
  host: '1.2.3.4',
  port: 22,
  username: 'root',
  auth_type: 'password',
  auth_value: 'super-secret',
}

describe('parseTotalFromRange', () => {
  it('parses total from Content-Range header', () => {
    expect(parseTotalFromRange('bytes 0-99/200')).toBe(200)
    expect(parseTotalFromRange('bytes 100-199/200')).toBe(200)
    expect(parseTotalFromRange('bytes 0-1023/2048')).toBe(2048)
  })
  it('returns 0 for empty string', () => {
    expect(parseTotalFromRange('')).toBe(0)
  })
  it('returns 0 for invalid format', () => {
    expect(parseTotalFromRange('invalid')).toBe(0)
    expect(parseTotalFromRange('bytes 0-99')).toBe(0)
  })
})

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

describe('downloadWithRange', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(resp: Partial<Response>) {
    const mock = vi.fn().mockResolvedValue(resp)
    globalThis.fetch = mock as unknown as typeof fetch
    return mock
  }

  it('sends credentials in POST body, never in the URL', async () => {
    const mock = stubFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Range': 'bytes 0-9/10' }),
      body: { getReader: () => ({}) } as unknown as ReadableStream<Uint8Array>,
    })

    await downloadWithRange(nodeWithSecret, '/tmp/a.txt', 0)

    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('super-secret')
    expect(url).not.toContain('node=')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.path).toBe('/tmp/a.txt')
    expect(body.node.auth_value).toBe('super-secret')
  })

  it('carries resume offset in the Range header', async () => {
    const mock = stubFetch({
      ok: false,
      status: 206,
      headers: new Headers({ 'Content-Range': 'bytes 100-199/200' }),
      body: { getReader: () => ({}) } as unknown as ReadableStream<Uint8Array>,
    })

    const { total } = await downloadWithRange(nodeWithSecret, '/tmp/a.txt', 100)

    const init = (mock.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Range).toBe('bytes=100-')
    expect(total).toBe(200)
  })

  it('rejects on error status', async () => {
    stubFetch({ ok: false, status: 404, headers: new Headers(), body: null })
    await expect(downloadWithRange(nodeWithSecret, '/missing.txt', 0)).rejects.toThrow('404')
  })

  it('surfaces the backend error message, not just a status code', async () => {
    stubFetch({
      ok: false,
      status: 502,
      headers: new Headers(),
      body: null,
      json: async () => ({ error: 'ssh connect: dial tcp 1.2.3.4:22: connection refused' }),
    })
    await expect(downloadWithRange(nodeWithSecret, '/tmp/a.txt', 0)).rejects.toThrow(
      'dial tcp 1.2.3.4:22',
    )
  })

  it('rejects when response body is null on success', async () => {
    stubFetch({ ok: true, status: 200, headers: new Headers(), body: null })
    await expect(downloadWithRange(nodeWithSecret, '/tmp/a.txt', 0)).rejects.toThrow(
      'response body is null',
    )
  })
})
