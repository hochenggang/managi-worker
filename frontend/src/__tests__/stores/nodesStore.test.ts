import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useNodesStore } from '@/stores/nodesStore'
import { generateNodeId, type ApiNode } from '@/protocol/types'

// mock 缓存写入以验证 debounce 行为
const { mockSetCachedNodes, mockSetCachedGroups } = vi.hoisted(() => ({
  mockSetCachedNodes: vi.fn(),
  mockSetCachedGroups: vi.fn(),
}))

vi.mock('@/api', () => ({
  getCachedNodes: vi.fn(() => []),
  setCachedNodes: mockSetCachedNodes,
  getCachedGroups: vi.fn(() => []),
  setCachedGroups: mockSetCachedGroups,
}))

// mock useTerminal 的 clearSessionId/clearAllSessionIds（nodesStore 导入它们）
vi.mock('@/composables/useTerminal', () => ({
  clearSessionId: vi.fn(),
  clearAllSessionIds: vi.fn(),
}))

const testNode: ApiNode = {
  name: 'node1',
  host: '1.2.3.4',
  port: 22,
  username: 'root',
  auth_type: 'password',
  auth_value: 'pass',
}

const testNode2: ApiNode = {
  ...testNode,
  name: 'node2',
  host: '5.6.7.8',
}

describe('useNodesStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mockSetCachedNodes.mockClear()
    mockSetCachedGroups.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('node CRUD', () => {
    it('setNode + getNodeById roundtrip', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      expect(store.getNodeById(generateNodeId(testNode))).toEqual(testNode)
    })

    it('getNodeById returns undefined for unknown id', () => {
      const store = useNodesStore()
      expect(store.getNodeById('unknown')).toBeUndefined()
    })

    it('removeNode removes from nodes and selection', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.addToSelectedNodes(generateNodeId(testNode))
      store.removeNode(generateNodeId(testNode))
      expect(store.getNodeById(generateNodeId(testNode))).toBeUndefined()
      expect(store.selectedNodes).not.toContain(generateNodeId(testNode))
    })

    it('clearNodes clears nodes and selection', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.addToSelectedNodes(generateNodeId(testNode))
      store.clearNodes()
      expect(store.allNodes).toHaveLength(0)
      expect(store.selectedNodes).toHaveLength(0)
    })

    it('setAllNodes batch sets multiple nodes', () => {
      const store = useNodesStore()
      store.setAllNodes([testNode, testNode2])
      expect(store.allNodes).toHaveLength(2)
    })
  })

  describe('selection', () => {
    it('addToSelectedNodes deduplicates', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.addToSelectedNodes(generateNodeId(testNode))
      store.addToSelectedNodes(generateNodeId(testNode))
      expect(store.selectedNodes).toHaveLength(1)
    })

    it('removeFromSelectedNodes removes specific id', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.setNode(testNode2)
      store.addToSelectedNodes(generateNodeId(testNode))
      store.addToSelectedNodes(generateNodeId(testNode2))
      store.removeFromSelectedNodes(generateNodeId(testNode))
      expect(store.selectedNodes).toEqual([generateNodeId(testNode2)])
    })

    it('clearSelectedNodes empties selection', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.addToSelectedNodes(generateNodeId(testNode))
      store.clearSelectedNodes()
      expect(store.selectedNodes).toHaveLength(0)
    })

    it('selectAllNodes selects all node ids', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.setNode(testNode2)
      store.selectAllNodes()
      expect(store.selectedNodes).toHaveLength(2)
      expect(store.selectedNodes).toContain(generateNodeId(testNode))
      expect(store.selectedNodes).toContain(generateNodeId(testNode2))
    })

    it('getSelectedNodes returns node objects', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.addToSelectedNodes(generateNodeId(testNode))
      expect(store.getSelectedNodes).toEqual([testNode])
    })

    it('allNodes getter returns array', () => {
      const store = useNodesStore()
      store.setNode(testNode)
      store.setNode(testNode2)
      expect(store.allNodes).toHaveLength(2)
    })
  })

  // 验证 save 被 debounce，连续变更只写一次 localStorage
  describe('debounced save (B16 fix)', () => {
    it('rapid changes trigger a single debounced save', async () => {
      const store = useNodesStore()
      mockSetCachedNodes.mockClear()
      mockSetCachedGroups.mockClear()
      // 连续多次变更，每次都触发 deep watch → scheduleSave
      store.setNode(testNode)
      store.setNode(testNode2)
      store.addToSelectedNodes(generateNodeId(testNode))
      store.addToSelectedNodes(generateNodeId(testNode2))
      await nextTick() // 等待 Vue watch 回调入队 scheduleSave
      // debounce 期间不应写入
      expect(mockSetCachedNodes).not.toHaveBeenCalled()
      // 推进 299ms，仍未到 300ms 阈值
      vi.advanceTimersByTime(299)
      expect(mockSetCachedNodes).not.toHaveBeenCalled()
      // 推进到 300ms，debounce 触发，只写一次
      vi.advanceTimersByTime(1)
      expect(mockSetCachedNodes).toHaveBeenCalledTimes(1)
      expect(mockSetCachedGroups).toHaveBeenCalledTimes(1)
    })

    it('save fires immediately after debounce window', async () => {
      const store = useNodesStore()
      mockSetCachedNodes.mockClear()
      store.setNode(testNode)
      await nextTick()
      vi.advanceTimersByTime(300)
      expect(mockSetCachedNodes).toHaveBeenCalledTimes(1)
      // 之后再变更，再次 debounce
      store.setNode(testNode2)
      await nextTick()
      expect(mockSetCachedNodes).toHaveBeenCalledTimes(1) // 仍未写入
      vi.advanceTimersByTime(300)
      expect(mockSetCachedNodes).toHaveBeenCalledTimes(2)
    })
  })
})
