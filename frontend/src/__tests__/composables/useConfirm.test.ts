import { describe, it, expect, beforeEach } from 'vitest'
import { useConfirm } from '@/composables/useConfirm'

describe('useConfirm', () => {
  beforeEach(() => {
    // 每次测试前重置全局状态
    const { cancel } = useConfirm()
    cancel()
  })

  it('confirm() returns a Promise and shows dialog', async () => {
    const { confirm, confirmState } = useConfirm()
    const p = confirm('are you sure?')
    expect(confirmState.value.visible).toBe(true)
    expect(confirmState.value.message).toBe('are you sure?')
    expect(p).toBeInstanceOf(Promise)
    // 不 resolve，避免悬挂
    confirmState.value.resolver?.(false)
    await p
  })

  it('accept() resolves true and hides dialog', async () => {
    const { confirm, accept, confirmState } = useConfirm()
    const p = confirm('delete?')
    accept()
    expect(await p).toBe(true)
    expect(confirmState.value.visible).toBe(false)
  })

  it('cancel() resolves false and hides dialog', async () => {
    const { confirm, cancel, confirmState } = useConfirm()
    const p = confirm('delete?')
    cancel()
    expect(await p).toBe(false)
    expect(confirmState.value.visible).toBe(false)
  })

  it('second confirm() auto-resolves previous as false', async () => {
    const { confirm, accept } = useConfirm()
    const p1 = confirm('first?')
    const p2 = confirm('second?')
    // 第一个应被自动 resolve 为 false
    expect(await p1).toBe(false)
    accept()
    expect(await p2).toBe(true)
  })
})
