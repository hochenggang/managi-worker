import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '@/stores/tabsStore'
import type { ApiNode } from '@/protocol/types'

function makeNode(name: string, host: string, port: number, username = 'root'): ApiNode {
  return { name, host, port, username, auth_type: 'password', auth_value: 'x' }
}

describe('tabsStore 节点标签判重', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // 判重必须用 host:port:username 全量身份；只比 host 会让同 host 的不同节点复用旧标签
  it('openTerminal: 同 host 不同 port 的节点各自开标签', () => {
    const store = useTabsStore()
    const a = store.openTerminal(makeNode('a', '1.1.1.1', 22))
    const b = store.openTerminal(makeNode('b', '1.1.1.1', 2222))
    expect(a.id).not.toBe(b.id)
    expect(store.tabs).toHaveLength(2)
    expect(store.activeTabId).toBe(b.id)
  })

  it('openTerminal: 同一节点复用已有标签并激活', () => {
    const store = useTabsStore()
    const node = makeNode('a', '1.1.1.1', 22)
    const first = store.openTerminal(node)
    store.openBatch()
    const again = store.openTerminal(makeNode('a', '1.1.1.1', 22))
    expect(again.id).toBe(first.id)
    expect(store.tabs.filter((t) => t.type === 'terminal')).toHaveLength(1)
    expect(store.activeTabId).toBe(first.id)
  })

  // 判重必须含凭据指纹：只比 host:port:username 时，改过密码的节点会复用旧标签，
  // 而旧标签持有的是登录时的旧凭据，用户以为连的是新密码那台。
  it('openTerminal: 同 host:port:username 不同凭据各自开标签', () => {
    const store = useTabsStore()
    const old = store.openTerminal({ ...makeNode('a', '1.1.1.1', 22), auth_value: 'old-pwd' })
    const fresh = store.openTerminal({ ...makeNode('a', '1.1.1.1', 22), auth_value: 'new-pwd' })
    expect(fresh.id).not.toBe(old.id)
    expect(store.tabs.filter((t) => t.type === 'terminal')).toHaveLength(2)
  })

  it('openSftp: 同节点的 terminal 与 sftp 标签互不复用', () => {
    const store = useTabsStore()
    const node = makeNode('a', '1.1.1.1', 22)
    const term = store.openTerminal(node)
    const sftp = store.openSftp(node)
    expect(sftp.id).not.toBe(term.id)
    expect(store.tabs.map((t) => t.type)).toEqual(['terminal', 'sftp'])
  })

  it('openBatch / openSettings: 单例标签只保留一个', () => {
    const store = useTabsStore()
    expect(store.openBatch().id).toBe(store.openBatch().id)
    expect(store.openSettings().id).toBe(store.openSettings().id)
    expect(store.tabs.filter((t) => t.type === 'batch')).toHaveLength(1)
    expect(store.tabs.filter((t) => t.type === 'settings')).toHaveLength(1)
  })
})
