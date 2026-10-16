<template>
  <div class="quick-command-panel">
    <div class="command-search">
      <input v-model="search" type="text" :placeholder="t('quickCommand.searchPlaceholder')" />
    </div>
    <div class="command-list">
      <div v-for="cmd in filteredCommands" :key="cmd.label" class="command-item" @click="emit('select', cmd.cmd)"
        @contextmenu.prevent="handleCommandContextMenu($event, cmd)" :title="cmd.cmd">
        <div class="command-meta">
          <div class="command-label">{{ cmd.label }}</div>
          <div class="command-preview">{{ cmd.cmd }}</div>
        </div>
      </div>
      <Transition name="cmd-empty">
        <div v-if="filteredCommands.length === 0" class="command-empty">
          {{ t('quickCommand.noResult') }}
        </div>
      </Transition>
    </div>
  </div>

  <ContextMenu v-model:visible="contextMenu.visible" :x="contextMenu.x" :y="contextMenu.y" :items="contextMenu.items" />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ContextMenu from '@/components/ContextMenu.vue'

const props = defineProps<{
  customCommands: { label: string; cmd: string }[]
}>()

const emit = defineEmits<{
  (e: 'select', cmd: string): void
  (e: 'rename', index: number): void
  (e: 'delete', index: number): void
}>()

interface CommandItem {
  category?: string
  label: string
  cmd: string
  originalIndex?: number
}

const { t, locale } = useI18n()

const search = ref('')
const contextMenu = ref({ visible: false, x: 0, y: 0, items: [] as { label: string; action?: () => void; danger?: boolean }[] })

interface BuiltInCommand {
  label: string
  cmd: string
}

const builtInCommands = computed<BuiltInCommand[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  locale.value
  return [
    { label: t('quickCommand.cmds.systemInfo'), cmd: 'uname -a && lsb_release -a 2>/dev/null || cat /etc/os-release' },
    { label: t('quickCommand.cmds.cpu'), cmd: 'top -bn1 | grep "Cpu(s)"' },
    { label: t('quickCommand.cmds.memory'), cmd: 'free -h' },
    { label: t('quickCommand.cmds.disk'), cmd: 'df -h' },
    { label: t('quickCommand.cmds.process'), cmd: 'ps aux --sort=-%cpu | head -20' },
    { label: t('quickCommand.cmds.uptime'), cmd: 'uptime' },
    { label: t('quickCommand.cmds.ip'), cmd: 'ip addr' },
    { label: t('quickCommand.cmds.route'), cmd: 'ip route' },
    { label: t('quickCommand.cmds.ping'), cmd: 'ping -c 4 8.8.8.8' },
    { label: t('quickCommand.cmds.ports'), cmd: 'ss -tlnp' },
    { label: t('quickCommand.cmds.findLargeFiles'), cmd: "find / -type f -size +100M -exec ls -lh {} \\; 2>/dev/null | head -10" },
    { label: t('quickCommand.cmds.tailLog'), cmd: 'tail -n 50 /var/log/syslog' },
    { label: t('quickCommand.cmds.grep'), cmd: 'grep -rn "TODO" /etc 2>/dev/null | head -20' },
  ]
})

const filteredCommands = computed<CommandItem[]>(() => {
  const customItems = props.customCommands
    .map((c, idx) => ({ category: 'custom' as const, label: c.label, cmd: c.cmd, originalIndex: idx }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))

  const all: CommandItem[] = [
    ...customItems,
    ...builtInCommands.value,
  ]
  const q = search.value.trim().toLowerCase()
  if (!q) return all
  return all.filter((cmd) => cmd.label.toLowerCase().includes(q) || cmd.cmd.toLowerCase().includes(q))
})

function handleCommandContextMenu(event: MouseEvent, cmd: CommandItem): void {
  if (cmd.category !== 'custom' || cmd.originalIndex === undefined) {
    return
  }
  const index = cmd.originalIndex
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    items: [
      { label: t('cmdPanel.rename'), action: () => emit('rename', index) },
      { label: t('cmdPanel.delete'), danger: true, action: () => emit('delete', index) },
    ],
  }
}
</script>

<style scoped>
.quick-command-panel {
  display: flex;
  flex-direction: column;
  width: 12rem;
  border-right: 1px solid var(--color-border);
  background: transparent;
  flex-shrink: 0;
}

.command-search {
  padding: 0.35rem;
  border-bottom: 1px solid var(--color-border);
}

.command-search input {
  width: 100%;
  padding: 0.25rem 0.4rem;
  font-size: 0.7rem;
  /* background-color: var(--color-input-bg); */
  /* border: 1px solid var(--color-border); */
  border-radius: 0;
  color: var(--color-font-1);
}

.command-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem;
}

.command-item {
  display: flex;
  align-items: center;
  padding: 0.3rem 0.4rem;
  border-radius: 0;
  cursor: pointer;
  transition: background-color 0.15s;
  opacity: 0.6;
  user-select: none;
}

.command-item:hover {
  background-color: var(--color-hover-bg);
  opacity: 1;
}

.command-item.active {
  background-color: var(--color-active-bg);
  opacity: 1;
}

.command-meta {
  min-width: 0;
}

.command-label {
  font-size: 0.7rem;
  color: var(--color-font-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.command-preview {
  font-size: 0.7rem;
  color: var(--color-font-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.command-empty {
  padding: 1rem;
  text-align: center;
  color: var(--color-font-3);
  font-size: 0.7rem;
}

/* 空状态淡入淡出 */
.cmd-empty-enter-active,
.cmd-empty-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.cmd-empty-enter-from,
.cmd-empty-leave-to {
  opacity: 0;
  transform: translateY(0.25rem);
}
</style>
