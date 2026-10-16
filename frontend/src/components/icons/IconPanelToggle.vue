<template>
  <svg viewBox="0 0 24 24" :class="['toggle-icon', { collapsed }]">
    <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" />
  </svg>
</template>

<script setup lang="ts">
defineProps<{
  collapsed?: boolean
}>()
</script>

<style scoped>
.toggle-icon {
  width: 1rem;
  height: 1rem;
  transition: transform 0.2s ease-in-out;
}

.collapsed {
  transform: rotate(180deg);
}
</style>
