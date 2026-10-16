<template>
  <Transition name="modal">
    <div class="modal-overlay" @click="emits('close');">
      <Transition name="modal-content" appear>
        <div class="modal" @click.stop>
          <slot></slot>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<script setup lang="ts">
const emits = defineEmits(['close'])
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
  cursor: pointer;
}

.modal {
  border-radius: 0;
  position: absolute;
  background: var(--color-panel-bg);
  border: 1px solid var(--color-border);
}

/* 遮罩淡入淡出 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

/* 内容缩放+上浮 */
.modal-content-enter-active {
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
}

.modal-content-leave-active {
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.modal-content-enter-from {
  transform: scale(0.92) translateY(1rem);
  opacity: 0;
}

.modal-content-leave-to {
  transform: scale(0.96);
  opacity: 0;
}
</style>
