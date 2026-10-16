<template>
  <div class="tab-bar">
    <div class="tabs">
      <div v-for="tab in tabsStore.tabs" :key="tab.id" class="tab" :data-tab-id="tab.id"
        :class="{ active: tab.id === tabsStore.activeTabId }"
        @click="tabsStore.activate(tab.id)" @contextmenu.prevent="showContextMenu($event, tab.id)">
        <span class="tab-icon">
          <IconTerm v-if="tab.type === 'terminal'" />
          <IconFinder v-else-if="tab.type === 'sftp'" />
          <IconSetting v-else-if="tab.type === 'settings'" />
          <IconBatch v-else-if="tab.type === 'batch'" />
          <span v-else class="default-icon">●</span>
        </span>
        <span class="tab-title">{{ tab.title }}</span>
        <button class="tab-close" @click.stop="tabsStore.close(tab.id)">×</button>
      </div>
      <button class="tab-add" @click="tabsStore.openBatch()" :title="t('tabs.newBatch')">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
        </svg>
      </button>
    </div>
    <div class="tab-actions">
      <slot></slot>
    </div>

    <Transition name="tab-ctx-menu">
      <div v-if="contextMenu.visible" class="context-menu"
        :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }">
        <div class="context-menu-item" @click="closeCurrent">{{ t('tabs.close') }}</div>
        <div class="context-menu-item" @click="closeOthers">{{ t('tabs.closeOthers') }}</div>
        <div class="context-menu-item" @click="closeAll">{{ t('tabs.closeAll') }}</div>
      </div>
    </Transition>
    <Transition name="tab-ctx-overlay">
      <div v-if="contextMenu.visible" class="context-menu-overlay" @click="contextMenu.visible = false"></div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTabsStore } from '@/stores/tabsStore'
import IconTerm from '@/components/icons/IconTerm.vue'
import IconFinder from '@/components/icons/IconFinder.vue'
import IconSetting from '@/components/icons/IconSetting.vue'
import IconBatch from '@/components/icons/IconBatch.vue'

const { t } = useI18n()
const tabsStore = useTabsStore()

const contextMenu = reactive({ visible: false, x: 0, y: 0, tabId: '' })

function showContextMenu(event: MouseEvent, tabId: string): void {
  contextMenu.x = event.clientX
  contextMenu.y = event.clientY
  contextMenu.tabId = tabId
  contextMenu.visible = true
}

function closeCurrent(): void {
  if (contextMenu.tabId) tabsStore.close(contextMenu.tabId)
  contextMenu.visible = false
}

function closeOthers(): void {
  if (contextMenu.tabId) tabsStore.closeOthers(contextMenu.tabId)
  contextMenu.visible = false
}

function closeAll(): void {
  tabsStore.closeAll()
  contextMenu.visible = false
}
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 2rem;
  background-color: var(--color-tab-bar-bg);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  user-select: none;
}

.tabs {
  display: flex;
  align-items: center;
  height: 100%;
  overflow-x: auto;
  flex: 1;
}

.tab {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  position: relative;
  height: calc(100% - 2px);
  padding: 0 0.75rem;
  margin-top: 2px;
  color: var(--color-font-3);
  background-color: var(--color-tab-inactive-bg);
  border-right: 1px solid var(--color-border);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
  max-width: 14rem;
  min-width: 6rem;
}

.tab.active {
  color: var(--color-font-1);
  background-color: var(--color-tab-active-bg);
}

.tab:hover {
  color: var(--color-font-1);
  background-color: var(--color-tab-hover-bg);
}

/* 图标悬停上浮由 main.css 的 --icon-lift 统一提供，此处不再重复定义 */

/* 活动标识条：由左向右展开（border-bottom 无法过渡，改用伪元素） */
.tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background-color: var(--color-accent);
  transform-origin: left center;
  animation: tab-indicator 0.18s ease-out;
}

@keyframes tab-indicator {
  from {
    transform: scaleX(0);
  }
}

.tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
}

.tab-icon svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}

.tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.7rem;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  padding: 0;
  margin-left: 0.25rem;
  border: none;
  background: transparent;
  color: var(--color-font-3);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s ease, transform 0.15s ease;
}

.tab-close:hover {
  color: var(--color-red);
  transform: scale(1.1);
}

.tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  margin-left: 0.25rem;
  border: none;
  background: transparent;
  color: var(--color-font-2);
  font-size: 1.1rem;
  cursor: pointer;
  border-radius: 0;
}

.tab-add svg {
  flex-shrink: 0;
}

.tab-add:hover {
  background-color: var(--color-hover-bg);
  color: var(--color-accent);
}

.tab-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0 0.5rem;
}

.context-menu {
  position: fixed;
  background-color: var(--color-menu-bg);
  border: 1px solid var(--color-border);
  border-radius: 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  z-index: 2000;
  min-width: 8rem;
  transform-origin: top left;
}

.context-menu-item {
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  color: var(--color-font-1);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.context-menu-item:hover {
  background-color: var(--color-hover-bg);
}

.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 1999;
}

/* 右键菜单缩放淡入 */
.tab-ctx-menu-enter-active,
.tab-ctx-menu-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.tab-ctx-menu-enter-from,
.tab-ctx-menu-leave-to {
  opacity: 0;
  transform: scale(0.92);
}

/* 遮罩淡入淡出 */
.tab-ctx-overlay-enter-active,
.tab-ctx-overlay-leave-active {
  transition: opacity 0.18s ease;
}

.tab-ctx-overlay-enter-from,
.tab-ctx-overlay-leave-to {
  opacity: 0;
}
</style>
