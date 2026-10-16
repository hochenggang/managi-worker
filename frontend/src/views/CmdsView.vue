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
          <ButtonWithSpinner class="execute-button" :loading="isExecuting" :action="executeCommand">
            {{ isExecuting ? t("cmdPanel.executing") : t("cmdPanel.executeCommand") }}
          </ButtonWithSpinner>
          <button class="small-button save-button" @click="startAddShortcut" :disabled="command.length < 2">
            <!-- {{ t("cmdPanel.saveShortCut") }} -->
            <IconSave style="fill: currentColor;" />
          </button>
        </div>
      </div>

      <ul v-auto-animate class="results">
        <li v-for="(result, index) in executionResults" :key="generateNodeId(result.node) + index" class="result">
          <div class="result-header">
            <strong :class="{ 'success': result.success, 'failed': !result.success }">
              {{ nodesStore.getNodeById(generateNodeId(result.node))?.name || result.node.host }}
            </strong>
            <span class="execution-time">{{ result.time_elapsed }}s</span>
          </div>
          <div class="output-block" v-if="result.output && result.output.length > 0">
            <pre><code>{{ joinLines(result.output) }}</code><button class="small-button copy-button" @click="copyCode(joinLines(result.output))">{{ t('cmdPanel.copy') }}</button></pre>
          </div>
          <div class="output-block error-block" v-if="result.error && result.error.length > 0">
            <pre><code>{{ joinLines(result.error) }}</code><button class="small-button copy-button" @click="copyCode(joinLines(result.error))">{{ t('cmdPanel.copy') }}</button></pre>
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
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import Modal from "@/components/Modal.vue";
import ButtonWithSpinner from "@/components/ButtonWithSpinner.vue";
import QuickCommandPanel from "@/components/QuickCommandPanel.vue";
import { useNodesStore } from '@/stores/nodesStore';
import { useShortcutsStore } from '@/stores/shortcutsStore';
import { generateNodeId } from '@/protocol/types';
import { handleError, handleMsg } from "@/helper";
import { batchSSH } from '@/api';
import { useConfirm } from '@/composables/useConfirm';
import type { CmdsTestResult } from '@/protocol/types';
import IconSave from '@/components/icons/IconSave.vue';

const { t } = useI18n()
const nodesStore = useNodesStore();
const shortcutsStore = useShortcutsStore();
shortcutsStore.load();

const command = ref('');
const executionResults = ref<CmdsTestResult[]>([]);
const newShortcutLabel = ref('');
const showAddShortcutModal = ref(false);
const isExecuting = ref(false);

const startAddShortcut = () => {
  if (command.value.length < 2) {
    handleError(t("cmdPanel.noCmd"));
  } else {
    showAddShortcutModal.value = true;
  }
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
  // 用 Modal 确认对话框替代原生 confirm()
  if (await confirm(t('cmdPanel.shortcutDeleteConfirm'))) {
    shortcutsStore.remove(index)
  }
}

const triggerExecute = () => {
  // 原 .catch(() => {}) 静默吞掉验证错误（emptyCmd/nothingSelected），用户无反馈
  executeCommand().catch((e: unknown) => {
    // executeCommand 内部已对 batchSSH 失败做 try/catch+handleError，
    // 此处仅处理它主动抛出的验证错误
    handleError(e)
  })
}

const executeCommand = async () => {
  if (command.value.length < 2) {
    throw new Error(t("cmdPanel.emptyCmd"));
  }
  if (nodesStore.selectedNodes.length === 0) {
    throw new Error(t("cmdPanel.nothingSelected"));
  }

  isExecuting.value = true;
  executionResults.value = [];

  const selectedNodes = nodesStore.getSelectedNodes;
  const cmds = command.value.split('\n');

  try {
    const results = await batchSSH(selectedNodes, cmds);
    executionResults.value = results;
  } catch (error) {
    // handleError 已放宽为 unknown，自动归一化 Error 为 message
    console.error(error)
    handleError(error)
  } finally {
    isExecuting.value = false;
  }
};

// 展示与复制共用同一份拼接结果，避免复制丢换行
const joinLines = (lines: string[]) => lines.join('\n')

const copyCode = (text: string) => {
  navigator.clipboard.writeText(text).then(() => {
    handleMsg(t("cmdPanel.copied"))
  }).catch(err => {
    handleError(t("cmdPanel.copyError") + err);
  });
};
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
  /* background-color: var(--color-input-bg);
  border: 1px solid var(--color-border); */
  border-radius: 0;
  font-size: 0.7rem;
  color: var(--color-font-1);
  resize: none;
}

.command-actions {
  display: flex;
  gap: 0.5rem;
}

.execute-button {
  font-size: 0.7rem;
}

.save-button {
  font-size: 0.7rem;
  flex-shrink: 0;
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
