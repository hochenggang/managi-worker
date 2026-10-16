// Pinia store：全局多标签页管理。
// 允许批量执行、终端、SFTP、设置等视图以独立标签同时存在；
// 通过保留所有标签组件实例实现连接后台保活。

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { i18n } from '@/i18n'
import { nodeSessionKey, type ApiNode } from '@/protocol/types'

export type TabType = 'batch' | 'terminal' | 'sftp' | 'settings'

export interface TabItem {
  id: string
  type: TabType
  title: string
  icon?: string
  props?: Record<string, unknown>
}

let idCounter = 0

function makeId(): string {
  return `tab-${Date.now()}-${++idCounter}`
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<TabItem[]>([])
  const activeTabId = ref<string>('')

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) || null)

  function activate(id: string): void {
    if (tabs.value.some((t) => t.id === id)) {
      activeTabId.value = id
    }
  }

  function add(tab: Omit<TabItem, 'id'>, options?: { activate?: boolean }): TabItem {
    const item: TabItem = { ...tab, id: makeId() }
    tabs.value.push(item)
    if (options?.activate !== false) {
      activeTabId.value = item.id
    }
    return item
  }

  // 单例标签：同类型只保留一个，已存在则激活
  function openSingleton(type: 'batch' | 'settings'): TabItem {
    const existing = tabs.value.find((t) => t.type === type)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const title = i18n.global.t(type === 'batch' ? 'tabs.batch' : 'tabs.settings')
    return add({ type, title, icon: type })
  }

  function nodeTabKey(type: TabType, node: ApiNode): string {
    return `${type}:${nodeSessionKey(node)}`
  }

  function nodeKeyOf(tab: TabItem): string {
    const node = tab.props?.node as ApiNode | undefined
    return node ? nodeTabKey(tab.type, node) : ''
  }

  // 节点级标签：同类型 + 同节点复用。
  // 判重键含 username 与凭据指纹（与后端连接池键同构）：只比 host 会让同主机的
  // 不同端口/账号节点复用旧标签，连到错误目标。
  function openNodeTab(type: 'terminal' | 'sftp', node: ApiNode): TabItem {
    const key = nodeTabKey(type, node)
    const existing = tabs.value.find((t) => nodeKeyOf(t) === key)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const suffix = type === 'terminal' ? '' : ` ${i18n.global.t('tabs.sftp')}`
    return add({
      type,
      title: `${node.name}${suffix}`,
      icon: type,
      props: { node },
    })
  }

  function openBatch(): TabItem {
    return openSingleton('batch')
  }

  function openTerminal(node: ApiNode): TabItem {
    return openNodeTab('terminal', node)
  }

  function openSftp(node: ApiNode): TabItem {
    return openNodeTab('sftp', node)
  }

  function openSettings(): TabItem {
    return openSingleton('settings')
  }

  function close(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    tabs.value.splice(idx, 1)
    if (activeTabId.value === id) {
      const next = tabs.value[Math.max(0, idx - 1)] || tabs.value[idx] || null
      activeTabId.value = next?.id ?? ''
    }
  }

  function closeOthers(id: string): void {
    const keep = tabs.value.find((t) => t.id === id)
    if (!keep) return
    tabs.value = [keep]
    activeTabId.value = keep.id
  }

  function closeAll(): void {
    tabs.value = []
    activeTabId.value = ''
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activate,
    add,
    openBatch,
    openTerminal,
    openSftp,
    openSettings,
    close,
    closeOthers,
    closeAll,
  }
})
