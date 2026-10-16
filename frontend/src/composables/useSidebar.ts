// 侧边栏折叠状态共享 composable。
// 模块级状态保证 App.vue 与 NodeList.vue 访问同一 collapsed 值。

import { ref, computed } from 'vue'

const STORAGE_KEY = 'sidebar-collapsed'
const EXPANDED_WIDTH = '20rem'
const COLLAPSED_WIDTH = '12rem'

const collapsed = ref(false)

function load(): void {
  // 默认收缩：未设置时 collapsed=true，仅在用户显式展开时才 false
  collapsed.value = localStorage.getItem(STORAGE_KEY) !== 'false'
}
load()

export function useSidebar() {
  const width = computed(() => (collapsed.value ? COLLAPSED_WIDTH : EXPANDED_WIDTH))

  function toggle(): void {
    collapsed.value = !collapsed.value
    localStorage.setItem(STORAGE_KEY, String(collapsed.value))
  }

  return {
    collapsed,
    width,
    toggle,
  }
}
