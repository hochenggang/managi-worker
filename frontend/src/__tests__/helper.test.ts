import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted 确保 mockNotify 在 vi.mock 工厂执行前已初始化
const { mockNotify } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
}))

vi.mock('@kyvg/vue3-notification', () => ({
  notify: mockNotify,
}))

import { handleMsg, handleError, toErrorMessage } from '@/helper'

describe('helper', () => {
  beforeEach(() => {
    mockNotify.mockClear()
  })

  it('handleMsg calls notify with type=success', () => {
    handleMsg('done')
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockNotify).toHaveBeenCalledWith({ type: 'success', text: 'done' })
  })

  it('handleError calls notify with type=error', () => {
    handleError('boom')
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockNotify).toHaveBeenCalledWith({ type: 'error', text: 'boom' })
  })

  it('handleMsg/handleError pass through multi-byte strings', () => {
    handleMsg('成功')
    handleError('失败')
    expect(mockNotify).toHaveBeenNthCalledWith(1, { type: 'success', text: '成功' })
    expect(mockNotify).toHaveBeenNthCalledWith(2, { type: 'error', text: '失败' })
  })

  // B1/B2 修复：handleError 接受 unknown 并归一化
  it('handleError normalizes Error object to its message (B1 fix)', () => {
    handleError(new Error('something failed'))
    expect(mockNotify).toHaveBeenCalledWith({ type: 'error', text: 'something failed' })
  })

  it('handleError normalizes unknown object via String() (B2 fix)', () => {
    handleError({ code: 500 })
    expect(mockNotify).toHaveBeenCalledWith({ type: 'error', text: '[object Object]' })
  })

  it('handleError handles null/undefined gracefully', () => {
    handleError(null)
    expect(mockNotify).toHaveBeenCalledWith({ type: 'error', text: 'null' })
    handleError(undefined)
    expect(mockNotify).toHaveBeenCalledWith({ type: 'error', text: 'undefined' })
  })

  // toErrorMessage 单元测试
  it('toErrorMessage returns string as-is', () => {
    expect(toErrorMessage('hello')).toBe('hello')
  })

  it('toErrorMessage extracts message from Error', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('toErrorMessage converts numbers to string', () => {
    expect(toErrorMessage(42)).toBe('42')
  })

  it('toErrorMessage converts null to "null"', () => {
    expect(toErrorMessage(null)).toBe('null')
  })
})
