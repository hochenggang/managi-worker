// Pinia store：节点、分组与选中态的单一数据源。
// 支持按分组管理节点，分组选择即选中组内全部节点。

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { ApiNode } from '@/protocol/types'
import { generateNodeId } from '@/protocol/types'
import { getCachedNodes, setCachedNodes, getCachedGroups, setCachedGroups } from '@/api'
import { clearSessionId, clearAllSessionIds } from '@/composables/useTerminal'

export const ALL_HOSTS_GROUP = ''

export const useNodesStore = defineStore('nodes', () => {
  const nodes = ref<Record<string, ApiNode>>({})
  const groups = ref<string[]>([])
  const selectedNodes = ref<string[]>([])
  const collapsedGroups = ref<Record<string, boolean>>({})

  function load(): void {
    nodes.value = {}
    getCachedNodes().forEach((node) => {
      nodes.value[generateNodeId(node)] = node
    })
    groups.value = getCachedGroups()
  }

  function save(): void {
    setCachedNodes(Object.values(nodes.value))
    setCachedGroups(groups.value)
  }

  // 批量操作（setAllNodes/clearNodes/导入）会触发多次 deep watch 回调，
  // 每次都写 localStorage 同步阻塞主线程。debounce 300ms 合并连续变更，降低 I/O 压力。
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, 300)
  }
  watch([nodes, groups], scheduleSave, { deep: true })

  const allNodes = computed(() => Object.values(nodes.value))
  const getSelectedNodes = computed(() =>
    selectedNodes.value.map((id) => nodes.value[id]).filter(Boolean),
  )

  const groupSet = computed(() => new Set(groups.value))

  function ensureGroup(name: string): void {
    if (name && !groupSet.value.has(name) && !groups.value.includes(name)) {
      groups.value.push(name)
    }
  }

  function addGroup(name: string): void {
    const trimmed = name.trim()
    if (!trimmed || groups.value.includes(trimmed)) return
    groups.value.push(trimmed)
  }

  function renameGroup(oldName: string, newName: string): void {
    const trimmed = newName.trim()
    if (!trimmed || oldName === trimmed) return
    const idx = groups.value.indexOf(oldName)
    if (idx === -1) return
    groups.value[idx] = trimmed
    Object.values(nodes.value).forEach((node) => {
      if (node.group === oldName) node.group = trimmed
    })
  }

  function removeGroup(name: string): void {
    const idx = groups.value.indexOf(name)
    if (idx !== -1) groups.value.splice(idx, 1)
    Object.values(nodes.value).forEach((node) => {
      if (node.group === name) delete node.group
    })
  }

  function setGroupOrder(order: string[]): void {
    groups.value = order.filter((g) => groupSet.value.has(g) || groups.value.includes(g))
  }

  function nodesInGroup(group: string): ApiNode[] {
    if (group === ALL_HOSTS_GROUP) return allNodes.value
    return Object.values(nodes.value)
      .filter((node) => node.group === group)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  function nodeIdsInGroup(group: string): string[] {
    return nodesInGroup(group).map(generateNodeId)
  }

  function isGroupSelected(group: string): boolean {
    const ids = nodeIdsInGroup(group)
    if (ids.length === 0) return false
    return ids.every((id) => selectedNodes.value.includes(id))
  }

  function isGroupPartiallySelected(group: string): boolean {
    const ids = nodeIdsInGroup(group)
    const selectedCount = ids.filter((id) => selectedNodes.value.includes(id)).length
    return selectedCount > 0 && selectedCount < ids.length
  }

  function toggleGroupSelection(group: string): void {
    const ids = nodeIdsInGroup(group)
    if (isGroupSelected(group)) {
      selectedNodes.value = selectedNodes.value.filter((id) => !ids.includes(id))
    } else {
      ids.forEach((id) => {
        if (!selectedNodes.value.includes(id)) selectedNodes.value.push(id)
      })
    }
  }

  function setNode(node: ApiNode): void {
    if (node.group) ensureGroup(node.group)
    nodes.value[generateNodeId(node)] = node
  }

  function getNodeById(id: string): ApiNode | undefined {
    return nodes.value[id]
  }

  function removeNode(id: string): void {
    const node = nodes.value[id]
    delete nodes.value[id]
    removeFromSelectedNodes(id)
    // 节点删除时清理其终端会话 ID 缓存，避免残留复用到已失效的后端会话
    if (node) clearSessionId(node)
  }

  function clearNodes(): void {
    nodes.value = {}
    groups.value = []
    selectedNodes.value = []
    // 清空 sessionId 缓存，避免残留复用到已失效的后端会话
    clearAllSessionIds()
  }

  function setAllNodes(list: ApiNode[], groupList?: string[]): void {
    nodes.value = {}
    // 导入配置覆盖全部节点，旧 sessionId 不再有效
    clearAllSessionIds()
    list.forEach(setNode)
    groups.value = groupList && groupList.length > 0
      ? groupList.filter((g) => g)
      : Array.from(new Set(list.map((n) => n.group).filter(Boolean) as string[]))
  }

  function moveNodeToGroup(id: string, group: string): void {
    const node = nodes.value[id]
    if (!node) return
    if (group) {
      ensureGroup(group)
      node.group = group
    } else {
      delete node.group
    }
  }

  function addToSelectedNodes(id: string): void {
    if (!selectedNodes.value.includes(id)) selectedNodes.value.push(id)
  }

  function removeFromSelectedNodes(id: string): void {
    selectedNodes.value = selectedNodes.value.filter((n) => n !== id)
  }

  function clearSelectedNodes(): void {
    selectedNodes.value = []
  }

  function selectAllNodes(): void {
    selectedNodes.value = Object.keys(nodes.value)
  }

  function toggleNodeSelection(id: string): void {
    if (selectedNodes.value.includes(id)) {
      removeFromSelectedNodes(id)
    } else {
      addToSelectedNodes(id)
    }
  }

  function toggleGroupCollapsed(group: string): void {
    collapsedGroups.value[group] = !collapsedGroups.value[group]
  }

  function isGroupCollapsed(group: string): boolean {
    return !!collapsedGroups.value[group]
  }

  load()

  return {
    nodes, groups, selectedNodes, collapsedGroups,
    allNodes, getSelectedNodes, groupSet,
    ensureGroup, addGroup, renameGroup, removeGroup, setGroupOrder,
    nodesInGroup, nodeIdsInGroup, isGroupSelected, isGroupPartiallySelected, toggleGroupSelection,
    setNode, getNodeById, removeNode, clearNodes, setAllNodes, moveNodeToGroup,
    addToSelectedNodes, removeFromSelectedNodes, clearSelectedNodes, selectAllNodes, toggleNodeSelection,
    toggleGroupCollapsed, isGroupCollapsed,
  }
})
