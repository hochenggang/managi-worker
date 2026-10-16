<template>
  <Finder :node="node" />
</template>

<script setup lang="ts">
import Finder from '@/components/Finder.vue'
import type { ApiNode } from '@/protocol/types'

defineProps<{ node: ApiNode }>()
</script>
