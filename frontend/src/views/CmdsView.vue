<template>
  <main class="batch-tab">
    <QuickCommandPanel
      :custom-commands="shortcutsStore.shortcuts"
      @select="command = $event"
      @rename="handleRenameShortcut"
      @delete="handleDeleteShortcut"
    />

    <div class="batch-main">
      <div class="command-area">
        <textarea
          v-model="command"
          :placeholder="t('cmdPanel.commandPlaceholder')"
          class="command-input"
          @keydown.ctrl.enter="triggerExecute"
        ></textarea>

        <div class="command-actions">
          <button
            v-if="!batch.running.value"
            class="execute-button small-button"
            :disabled="!canRun"
            @click="triggerExecute"
          >
            {{ t("cmdPanel.executeCommand") }}
          </button>
          <button v-else class="execute-button small-button stop-button" @click="batch.cancel()">
            {{ t("cmdPanel.stop") }}
          </button>
          <button class="small-button save-button" @click="startAddShortcut" :disabled="command.length < 2">
            <IconSave style="fill: currentColor;" />
          </button>
          <span class="hint">{{ hint }}</span>
        </div>
      </div>

      <ul class="results">
        <li v-for="row in batch.rows.value" :key="row.id" class="result">
          <div class="result-header">
            <strong :class="stateClass(row)">
              {{ nodesStore.getNodeById(row.id)?.name || row.node.host }}
            </strong>
            <span class="execution-time">
              <span v-if="row.state !== 'queued'">{{ stateText(row) }}</span>
              <span v-if="row.elapsedMs > 0"> · {{ (row.elapsedMs / 1000).toFixed(1) }}s</span>
            </span>
          </div>

          <div class="output-block error-block" v-if="row.error">
            <pre><code>{{ row.error }}</code></pre>
          </div>

          <div class="output-block" v-if="row.stdout">
            <pre><code>{{ row.stdout }}</code><button class="small-button copy-button" @click="copyCode(row.stdout)">{{ t('cmdPanel.copy') }}</button></pre>
          </div>

          <!-- stderr 单独一块：批量执行里「报错在哪」比「输出了什么」更要紧，
               混进 stdout 就再也分不出来了 -->
          <div class="output-block error-block" v-if="row.stderr">
            <pre><code>{{ row.stderr }}</code><button class="small-button copy-button" @click="copyCode(row.stderr)">{{ t('cmdPanel.copy') }}</button></pre>
          </div>

          <div class="output-block running-block" v-if="row.state === 'running' && !row.stdout && !row.stderr">
            <pre><code>{{ t('cmdPanel.executing') }}</code></pre>
          </div>

          <div class="result-footer" v-if="row.state === 'done' || row.state === 'failed'">
            <span v-if="row.code === null" class="warn">{{ t('cmdPanel.unknownCode') }}</span>
            <span v-else-if="row.code !== 0" class="warn">{{ t('cmdPanel.exitCode') }} {{ row.code }}</span>
            <span v-if="row.truncatedStdout || row.truncatedStderr" class="warn">
              {{ t('cmdPanel.serverTruncated') }}
            </span>
            <span v-if="row.trimmed" class="warn">{{ t('cmdPanel.displayTrimmed') }}</span>
          </div>
        </li>
      </ul>
    </div>

    <Modal @close="showAddShortcutModal = false" v-if="showAddShortcutModal">
      <main class="modal-content">
        <h2>{{ t("cmdPanel.saveShortCut") }}</h2>
        <input class="shortcut-input" v-model="newShortcutLabel" :placeholder="t('cmdPanel.saveShortCutPlaceholder')" autofocus />
        <div class="buttons">
          <button class="sucess" @click="confirmAddShortcut">{{ t("cmdPanel.confirmAddShortcut") }}</button>
          <button @click="showAddShortcutModal = false">{{ t("cmdPanel.cancelShortCut") }}</button>
        </div>
      </main>
    </Modal>
  </main>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import Modal from "@/components/Modal.vue";
import QuickCommandPanel from "@/components/QuickCommandPanel.vue";
import { useNodesStore } from '@/stores/nodesStore';
import { useShortcutsStore } from '@/stores/shortcutsStore';
import { handleError, handleMsg } from "@/helper";
import { useConfirm } from '@/composables/useConfirm';
import { useBatchExec, type ExecRow } from '@/composables/useBatchExec';
import IconSave from '@/components/icons/IconSave.vue';

const { t } = useI18n()
const nodesStore = useNodesStore();
const shortcutsStore = useShortcutsStore();
shortcutsStore.load();

const batch = useBatchExec()

const command = ref('');
const newShortcutLabel = ref('');
const showAddShortcutModal = ref(false);

const canRun = computed(() => command.value.length >= 2 && nodesStore.selectedNodes.length > 0)

const hint = computed(() => {
  const count = nodesStore.selectedNodes.length
  if (!count) return t('cmdPanel.nothingSelected')
  if (count > 1) return t('cmdPanel.parallelHint', { n: batch.concurrency.value })
  return ''
})

const startAddShortcut = () => {
  if (command.value.length < 2) {
    handleError(t("cmdPanel.noCmd"));
    return
  }
  showAddShortcutModal.value = true;
};

const confirmAddShortcut = () => {
  if (newShortcutLabel.value && command.value) {
    shortcutsStore.add({ label: newShortcutLabel.value, cmd: command.value });
    newShortcutLabel.value = '';
    showAddShortcutModal.value = false;
  } else {
    handleError(t("cmdPanel.shortcutNameRequired"));
  }
};

const handleRenameShortcut = (index: number) => {
  const item = shortcutsStore.shortcuts[index]
  if (!item) return
  const name = window.prompt(t('cmdPanel.renameShortcut'), item.label)
  if (name) shortcutsStore.rename(index, name.trim())
}

const { confirm } = useConfirm()

const handleDeleteShortcut = async (index: number) => {
  if (await confirm(t('cmdPanel.shortcutDeleteConfirm'))) {
    shortcutsStore.remove(index)
  }
}

/** triggerExecute 由按钮与 Ctrl+Enter 共用。
 *  校验失败必须出声：旧实现把验证错误静默吞掉，用户以为点了没反应。
 */
const triggerExecute = () => {
  if (command.value.length < 2) {
    handleError(t('cmdPanel.emptyCmd'))
    return
  }
  if (nodesStore.selectedNodes.length === 0) {
    handleError(t('cmdPanel.nothingSelected'))
    return
  }
  // 多行命令原样交给远端 shell：一次 exec 跑完整个脚本，
  // 比按行发 N 次更接近用户在大终端里粘贴一段脚本的心智模型。
  void batch.run(nodesStore.getSelectedNodes, command.value)
}

function stateText(row: ExecRow): string {
  switch (row.state) {
    case 'queued': return t('cmdPanel.queued')
    case 'running': return t('cmdPanel.executing')
    case 'done': return t('cmdPanel.done')
    case 'failed': return t('cmdPanel.failed')
    case 'cancelled': return t('cmdPanel.cancelled')
  }
}

function stateClass(row: ExecRow): string {
  if (row.state === 'done') return 'success'
  if (row.state === 'failed') return 'failed'
  return ''
}

const copyCode = (text: string) => {
  navigator.clipboard.writeText(text).then(() => {
    handleMsg(t("cmdPanel.copied"))
  }).catch(err => {
    handleError(t("cmdPanel.copyError") + err);
  });
};

// 标签页会被 tabsStore 保活（v-show），关标签不一定触发卸载；
// 但真卸载时把在跑的通道收掉，否则远端进程会一直跑到自己结束。
onUnmounted(() => batch.cancel())
</script>

<style scoped>
.batch-tab {
  display: flex;
  height: 100%;
  background-color: var(--color-bg);
  overflow: hidden;
}

.batch-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0.35rem;
  gap: 0.75rem;
  overflow: hidden;
}

.command-area {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex-shrink: 0;
}

.command-input {
  width: 100%;
  height: 7rem;
  padding: 0.5rem;
  border-radius: 0;
  font-size: 0.7rem;
  color: var(--color-font-1);
  resize: none;
}

.command-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.execute-button {
  font-size: 0.7rem;
}

.stop-button {
  color: var(--color-red);
}

.save-button {
  font-size: 0.7rem;
  flex-shrink: 0;
}

.hint {
  font-size: 0.65rem;
  color: var(--color-font-3);
}

.results {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.result {
  padding: 0.5rem;
  background-color: var(--color-panel-bg);
  border-radius: 0;
  border: 1px solid var(--color-border);
  margin-bottom: 0.5rem;
  font-size: 0.7rem;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.execution-time {
  font-size: 0.75rem;
  color: var(--color-font-3);
}

.success {
  font-weight: bold;
  color: var(--color-green);
}

.failed {
  font-weight: bold;
  color: var(--color-red);
}

.output-block {
  margin: 0.5rem 0;
  position: relative;
  background-color: var(--color-input-bg);
  border-radius: 0;
  overflow-x: auto;
}

.output-block pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  padding: 0.75rem 1rem;
}

.output-block code {
  display: block;
  font-family: monospace;
  font-size: 0.8rem;
  line-height: 1.4;
}

.error-block {
  border-left: 3px solid var(--color-orange);
}

.running-block {
  opacity: 0.7;
}

.result-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.65rem;
}

.warn {
  color: var(--color-orange);
}

.copy-button {
  width: auto;
  min-width: 0.5rem;
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
}

.modal-content {
  width: 25rem;
  padding: 1.5rem;
}

.shortcut-input {
  margin: 0.5rem 0;
  line-height: 1.5rem;
}
</style>
