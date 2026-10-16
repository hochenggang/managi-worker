<template>
  <AddNode v-if="showAddNodeModal" :node="newNode" @close="showAddNodeModal = false" @add-node="handleAddNode" />

  <div class="node-list-container" :class="{ collapsed }">
    <div class="node-list">
      <div class="sidebar-header">
        <div class="search-box">
          <input v-model="search" type="text" :placeholder="t('sidebar.search')" />
        </div>
        <button class="icon-btn add-node-btn" :title="t('header.actions.add')" @click="startAddNode()">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
          </svg>
        </button>
      </div>

      <div class="groups">
        <div v-for="group in displayGroups" :key="group.name" class="group"
          :class="{ collapsed: isGroupCollapsed(group.name), 'all-hosts': group.name === ALL_HOSTS_GROUP }">
          <div class="group-header" :class="{
            selected: isGroupSelected(group.name),
            partial: isGroupPartiallySelected(group.name),
          }" @click="handleGroupClick(group.name)" @contextmenu.prevent="showGroupMenu($event, group.name)">
            <span class="chevron" @click.stop="nodesStore.toggleGroupCollapsed(group.name)">
              <svg :class="{ 'expand': !isGroupCollapsed(group.name) }" viewBox="0 0 24 24" width="12" height="12">
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" />
              </svg>
            </span>
            <span class="group-name">{{ group.label }}</span>
            <span class="group-count">{{ group.count }}</span>
          </div>

          <div class="group-nodes-wrapper" :class="{ expanded: !isGroupCollapsed(group.name) }">
            <div class="group-nodes">
            <div v-for="node in group.nodes" :key="generateNodeId(node)" class="node"
              :class="{ selected: selectedNodes.includes(generateNodeId(node)) }"
              @click="nodesStore.toggleNodeSelection(generateNodeId(node))"
              @mouseenter="hoverNodeId = generateNodeId(node)" @mouseleave="hoverNodeId = ''"
              @contextmenu.prevent="showNodeMenu($event, node)">
              <span class="node-status"></span>
              <span class="node-name" :title="`${node.name} (${node.host}:${node.port})`">{{ node.name }}</span>
              <div v-show="hoverNodeId === generateNodeId(node)" class="node-actions">
                <IconTerm :title="t('xtermPanel.terminal')"
                  @click.stop="openNodeTab('terminal', $event, node)" />
                <IconFinder :title="t('xtermPanel.finder')" @click.stop="openNodeTab('sftp', $event, node)" />
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>

      <div class="sidebar-footer">
        <button class="icon-btn collapse-btn" :title="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          @click="toggle">
          <svg v-if="!collapsed" viewBox="0 0 24 24" width="16" height="16">
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
        </button>
        <button class="icon-btn settings-btn" :title="t('header.actions.settings')" @click="tabsStore.openSettings()">
          <IconSetting class="icon" />
        </button>
      </div>
    </div>
  </div>

  <ContextMenu v-model:visible="contextMenu.visible" :x="contextMenu.x" :y="contextMenu.y" :items="contextMenu.items" />
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import AddNode from '@/components/AddNode.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import IconTerm from '@/components/icons/IconTerm.vue'
import IconFinder from '@/components/icons/IconFinder.vue'
import IconSetting from '@/components/icons/IconSetting.vue'
import { useSidebar } from '@/composables/useSidebar'
import { useConfirm } from '@/composables/useConfirm'
import { flyToTab } from '@/composables/flyToTab'
import { useI18n } from 'vue-i18n'

import type { ApiNode } from '@/protocol/types'
import { generateNodeId } from '@/protocol/types'
import { useNodesStore, ALL_HOSTS_GROUP } from '@/stores/nodesStore'
import { useTabsStore } from '@/stores/tabsStore'

const nodesStore = useNodesStore()
const tabsStore = useTabsStore()
const { collapsed, toggle } = useSidebar()
const { t } = useI18n()

const search = ref('')
const showAddNodeModal = ref(false)
const hoverNodeId = ref('')
const contextMenu = ref({ visible: false, x: 0, y: 0, items: [] as { label: string; action?: () => void; danger?: boolean }[] })

const newNode = ref<ApiNode>({
  name: '',
  host: '',
  port: 22,
  username: 'root',
  auth_type: 'password' as const,
  auth_value: '',
  group: '',
})

const selectedNodes = computed(() => nodesStore.selectedNodes)
const isGroupSelected = (group: string) => nodesStore.isGroupSelected(group)
const isGroupPartiallySelected = (group: string) => nodesStore.isGroupPartiallySelected(group)
const isGroupCollapsed = (group: string) => nodesStore.isGroupCollapsed(group)

interface DisplayGroup {
  name: string
  label: string
  count: number
  nodes: ApiNode[]
}

const displayGroups = computed<DisplayGroup[]>(() => {
  const q = search.value.trim().toLowerCase()
  const all: DisplayGroup[] = []

  const allNodes = nodesStore.allNodes.slice().sort((a, b) => a.name.localeCompare(b.name))
  const filteredAll = q ? allNodes.filter((n) => n.name.toLowerCase().includes(q) || n.host.toLowerCase().includes(q)) : allNodes
  all.push({
    name: ALL_HOSTS_GROUP,
    label: t('sidebar.allHosts'),
    count: allNodes.length,
    nodes: filteredAll,
  })

  nodesStore.groups.forEach((groupName) => {
    const groupNodes = nodesStore.nodesInGroup(groupName)
    const filtered = q
      ? groupNodes.filter((n) => n.name.toLowerCase().includes(q) || n.host.toLowerCase().includes(q))
      : groupNodes
    if (q && filtered.length === 0 && !groupName.toLowerCase().includes(q)) return
    all.push({
      name: groupName,
      label: groupName,
      count: groupNodes.length,
      nodes: filtered,
    })
  })

  return all
})

function handleGroupClick(group: string): void {
  nodesStore.toggleGroupSelection(group)
}

function startAddNode(group = ''): void {
  newNode.value = {
    name: '',
    host: '',
    port: 22,
    username: 'root',
    auth_type: 'password' as const,
    auth_value: '',
    group,
  }
  showAddNodeModal.value = true
}

function handleAddNode(node: ApiNode): void {
  nodesStore.setNode(node)
  showAddNodeModal.value = false
}

function editNode(node: ApiNode): void {
  newNode.value = { ...node }
  showAddNodeModal.value = true
}

const { confirm } = useConfirm()

async function confirmDeleteNode(node: ApiNode): Promise<void> {
  // 用 Modal 确认对话框替代原生 confirm()
  if (await confirm(`${t('header.actions.delete')} ${node.name}?`)) {
    nodesStore.removeNode(generateNodeId(node))
  }
}

function createGroup(): void {
  const name = window.prompt(t('sidebar.newGroupPlaceholder'))
  if (name) nodesStore.addGroup(name.trim())
}

function showGroupMenu(event: MouseEvent, group: string): void {
  const items: { label: string; action?: () => void; danger?: boolean }[] = []
  if (group === ALL_HOSTS_GROUP) {
    items.push({ label: t('sidebar.newGroup'), action: createGroup })
  } else {
    items.push({
      label: t('sidebar.renameGroup'), action: () => {
        const name = window.prompt(t('sidebar.renameGroupPlaceholder'), group)
        if (name) nodesStore.renameGroup(group, name.trim())
      }
    })
    items.push({
      label: t('sidebar.deleteGroup'), danger: true, action: async () => {
        // 用 Modal 确认对话框替代原生 confirm()
        if (await confirm(`${t('sidebar.deleteGroupConfirm')} ${group}?`)) nodesStore.removeGroup(group)
      }
    })
  }
  openContextMenu(event, items)
}

// 点击节点上的终端/文件管理图标：开标签 + 让图标飞入该标签，建立"来源→标签"的视觉因果。
// currentTarget 只在事件派发期间有效，必须在 await 前取出。
function openNodeTab(type: 'terminal' | 'sftp', event: MouseEvent, node: ApiNode): void {
  const from = event.currentTarget as Element
  const tab = type === 'terminal' ? tabsStore.openTerminal(node) : tabsStore.openSftp(node)
  nextTick(() => flyToTab(from, tab.id))
}

function showNodeMenu(event: MouseEvent, node: ApiNode): void {
  const nodeId = generateNodeId(node)
  const groupItems = nodesStore.groups.map((g) => ({
    label: `${t('sidebar.moveToGroup')} "${g}"`,
    action: () => nodesStore.moveNodeToGroup(nodeId, g),
  }))
  groupItems.unshift({ label: t('sidebar.moveToUngrouped'), action: () => nodesStore.moveNodeToGroup(nodeId, '') })

  openContextMenu(event, [
    { label: t('header.actions.edit'), action: () => editNode(node) },
    ...groupItems,
    { label: t('header.actions.delete'), danger: true, action: () => confirmDeleteNode(node) },
  ])
}

function openContextMenu(event: MouseEvent, items: { label: string; action?: () => void; danger?: boolean }[]): void {
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, items }
}
</script>

<style scoped>
.node-list-container {
  position: fixed;
  left: 0;
  top: 0;
  height: 100%;
  width: var(--sidebar-width, 20rem);
  z-index: 2;
  background: var(--color-sidebar-bg);
  transition: width 0.2s ease-in-out;
}

.node-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  border-right: 1px solid var(--color-border);
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2rem;
  padding: 0 0.35rem;
  border-bottom: 1px solid var(--color-border);
}

.search-box {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.1rem 0.2rem;
  background-color: var(--color-input-bg);
  border: 1px solid var(--color-border);
  border: none;
  border-radius: 0;
}

.search-box input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: var(--color-font-1);
  font-size: 0.7rem;
  outline: none;
  text-align: left;
  padding-bottom: 0;
}

.search-box input::placeholder {
  color: var(--color-font-3);
}

.add-node-btn {
  flex-shrink: 0;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--color-font-2);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.icon-btn:hover {
  background-color: var(--color-hover-bg);
  color: var(--color-accent);
}

.icon-btn svg {
  fill: currentColor;
}

.groups {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;
}

.group {
  margin-bottom: 0.25rem;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0.45rem 0.5rem;
  border-radius: 0;
  cursor: pointer;
  user-select: none;
  color: var(--color-font-2);
  font-size: 0.7rem;
  transition: background-color 0.15s, color 0.15s;
}

.group-header:hover {
  background-color: var(--color-hover-bg);
  color: var(--color-font-1);
}

.group-header.selected {
  background-color: var(--color-selected-bg);
  color: var(--color-accent);
}

.group-header.partial {
  color: var(--color-accent);
}

.group-header.all-hosts {
  font-weight: 600;
  color: var(--color-font-1);
}

.group-header.all-hosts.selected {
  color: var(--color-accent);
}

.chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}

.chevron svg.expand {
  transform: rotate(90deg);
}

.chevron svg {
  transition: all 0.2s ease-in-out;
}

.chevron svg {
  fill: currentColor;
}

.group-name {
  margin-left: 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  margin-left: auto;
  padding-left: 0.5rem;
  color: var(--color-font-3);
  font-size: 0.7rem;
}

.group-nodes-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s ease;
}

.group-nodes-wrapper.expanded {
  grid-template-rows: 1fr;
}

.group-nodes {
  overflow: hidden;
  min-height: 0;
  padding-left: 1.5rem;
}

.node {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0;
  margin: 2px;
  border-radius: 0;
  cursor: pointer;
  font-size: 0.7rem;
  color: var(--color-font-2);
  transition: background-color 0.15s, color 0.15s;
  user-select: none;
}

.node:hover {
  /* background-color: var(--color-hover-bg);
  color: var(--color-font-1); */
}


.node.selected {
  /* background-color: var(--color-selected-bg); */
  color: var(--color-accent);
}

.node-status {
  display: none;
}

.node.selected .node-status {
  display: block;
  position: absolute;
  top: 50%;
  left: -12px;
  transform: translateY(-50%);
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 50%;
  background-color: var(--color-green);
  flex-shrink: 0;
}

.node-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

.node-actions svg {
  width: 0.85rem;
  height: 0.85rem;
  fill: currentColor;
}

.node-actions svg:hover {
  fill: var(--color-accent);
}

.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--color-border);
  height: 2rem;
}

.settings-btn .icon {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}
</style>
