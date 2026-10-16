<template>
  <Modal v-if="confirmState.visible" @close="cancel">
    <main class="confirm-dialog">
      <p class="confirm-message">{{ confirmState.message }}</p>
      <div class="confirm-buttons">
        <button class="danger" @click="accept">{{ t('finder.ok') }}</button>
        <button @click="cancel">{{ t('finder.cancle') }}</button>
      </div>
    </main>
  </Modal>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Modal from '@/components/Modal.vue'
import { useConfirm } from '@/composables/useConfirm'

const { t } = useI18n()
const { confirmState, accept, cancel } = useConfirm()
</script>

<style scoped>
.confirm-dialog {
  width: 22rem;
  padding: 1.5rem;
}

.confirm-message {
  color: var(--color-font-1);
  white-space: pre-line;
  line-height: 1.5;
  margin: 0 0 1.25rem 0;
}

.confirm-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.confirm-buttons button {
  padding: 0.35rem 0.85rem;
  border-radius: 0;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-font-1);
}

.confirm-buttons button.danger {
  background: var(--color-red);
  color: #fff;
  border-color: var(--color-red);
}

.confirm-buttons button:hover {
  opacity: 0.85;
}
</style>
