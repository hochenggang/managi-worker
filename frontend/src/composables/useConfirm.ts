// useConfirm：全局确认对话框 composable。
// 替代原生 confirm()，提供与应用主题一致的 Modal 确认对话框。
// 调用方使用 const { confirm } = useConfirm()，await confirm(message) 返回 boolean。

import { ref } from 'vue'

interface ConfirmState {
  visible: boolean
  message: string
  resolver: ((value: boolean) => void) | null
}

// 模块级单例状态，所有调用方共享同一个对话框实例
const state = ref<ConfirmState>({
  visible: false,
  message: '',
  resolver: null,
})

export function useConfirm() {
  /** confirm 显示确认对话框，返回用户选择（true=确认，false=取消）。 */
  function confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      // 若上一个确认仍在，先 resolve false（避免悬挂）
      if (state.value.resolver) {
        state.value.resolver(false)
      }
      state.value = {
        visible: true,
        message,
        resolver: resolve,
      }
    })
  }

  function accept(): void {
    if (state.value.resolver) {
      state.value.resolver(true)
    }
    state.value = { visible: false, message: '', resolver: null }
  }

  function cancel(): void {
    if (state.value.resolver) {
      state.value.resolver(false)
    }
    state.value = { visible: false, message: '', resolver: null }
  }

  return { confirmState: state, confirm, accept, cancel }
}
