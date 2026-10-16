<template>
  <teleport to="body">
    <Transition name="ctx-menu">
      <div
        v-if="visible"
        class="context-menu"
        :style="{ top: y + 'px', left: x + 'px' }"
        @click.stop
      >
        <div
          v-for="item in items"
          :key="item.label"
          class="context-menu-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          @click="handleClick(item)"
        >
          {{ item.label }}
        </div>
      </div>
    </Transition>
    <Transition name="ctx-overlay">
      <div v-if="visible" class="context-menu-overlay" @click="close"></div>
    </Transition>
  </teleport>
</template>

<script setup lang="ts">
export interface MenuItem {
  label: string
  action?: () => void
  danger?: boolean
  disabled?: boolean
}

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: MenuItem[]
}>()

const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

function close(): void {
  emit('update:visible', false)
}

function handleClick(item: MenuItem): void {
  if (item.disabled) return
  item.action?.()
  close()
}
</script>

<style scoped>
.context-menu {
  position: fixed;
  min-width: 8rem;
  padding: 0.35rem 0;
  background-color: var(--color-menu-bg);
  border: 1px solid var(--color-border);
  border-radius: 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 2000;
}

.context-menu-item {
  padding: 0.45rem 0.75rem;
  font-size: 0.8rem;
  color: var(--color-font-1);
  cursor: pointer;
  transition: background-color 0.15s;
}

.context-menu-item:hover:not(.disabled) {
  background-color: var(--color-hover-bg);
}

.context-menu-item.danger {
  color: var(--color-red);
}

.context-menu-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 1999;
}

/* 菜单缩放淡入 */
.ctx-menu-enter-active {
  transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease;
  transform-origin: top left;
}

.ctx-menu-leave-active {
  transition: transform 0.12s ease, opacity 0.1s ease;
  transform-origin: top left;
}

.ctx-menu-enter-from {
  transform: scale(0.88);
  opacity: 0;
}

.ctx-menu-leave-to {
  transform: scale(0.92);
  opacity: 0;
}

/* 遮罩淡入淡出 */
.ctx-overlay-enter-active,
.ctx-overlay-leave-active {
  transition: opacity 0.2s ease;
}

.ctx-overlay-enter-from,
.ctx-overlay-leave-to {
  opacity: 0;
}
</style>
