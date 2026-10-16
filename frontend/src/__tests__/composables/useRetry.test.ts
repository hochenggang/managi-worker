import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useRetry } from '@/composables/useRetry'

describe('useRetry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('succeeds on first try without retry', async () => {
    const { retrying, withRetry } = useRetry()
    const fn = vi.fn().mockResolvedValue('ok')
    const p = withRetry(fn)
    expect(retrying.value).toBe(false)
    const r = await p
    expect(r).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(retrying.value).toBe(false)
  })

  it('retries then succeeds', async () => {
    const { retrying, withRetry } = useRetry()
    // 在 fn 内捕获 retrying.value，验证首次调用=false、重试调用=true
    const retryingDuringCall: boolean[] = []
    const fn = vi.fn()
      .mockImplementationOnce(async () => {
        retryingDuringCall.push(retrying.value)
        throw new Error('boom')
      })
      .mockImplementationOnce(async () => {
        retryingDuringCall.push(retrying.value)
        return 'ok'
      })
    const p = withRetry(fn, { baseDelay: 100, maxRetries: 3 })
    await vi.advanceTimersByTimeAsync(100)
    const r = await p
    expect(r).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(retryingDuringCall[0]).toBe(false) // 首次调用：未在重试
    expect(retryingDuringCall[1]).toBe(true) // 重试调用：正在重试
  })

  it('throws after exceeding maxRetries', async () => {
    const { withRetry } = useRetry()
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    const p = withRetry(fn, { baseDelay: 100, maxRetries: 2 })
    // 立即附加 catch 避免 unhandled rejection 警告
    const guard = p.catch((e) => e)
    // 推进两次退避延迟（100ms 与 200ms）
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(200)
    const err = await guard
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('always fail')
    expect(fn).toHaveBeenCalledTimes(3) // 首次 + 2 次重试
  })

  it('does not retry when shouldRetry returns false', async () => {
    const { withRetry } = useRetry()
    const fn = vi.fn().mockRejectedValue(new Error('nope'))
    const p = withRetry(fn, { shouldRetry: () => false })
    await expect(p).rejects.toThrow('nope')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('exponential backoff respects baseDelay', async () => {
    const { withRetry } = useRetry()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('ok')
    const p = withRetry(fn, { baseDelay: 100, maxRetries: 3 })
    // 第 1 次重试前应等 100ms（baseDelay * 2^0）
    await vi.advanceTimersByTimeAsync(99)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
    // 第 2 次重试前应等 200ms（baseDelay * 2^1）
    await vi.advanceTimersByTimeAsync(199)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('caps delay at maxDelay', async () => {
    const { withRetry } = useRetry()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('ok')
    const p = withRetry(fn, { baseDelay: 4000, maxDelay: 5000, maxRetries: 3 })
    // 第 1 次等 4000ms（4000 * 2^0 = 4000）
    await vi.advanceTimersByTimeAsync(4000)
    expect(fn).toHaveBeenCalledTimes(2)
    // 第 2 次理论 8000ms，封顶 5000ms
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('defaultShouldRetry (via withRetry)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retries on Error code 5xx', async () => {
    const { withRetry } = useRetry()
    const err500 = new Error('Error code 500')
    const fn = vi.fn()
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce('ok')
    const p = withRetry(fn, { baseDelay: 10, maxRetries: 3 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry on Error code 4xx', async () => {
    const { withRetry } = useRetry()
    const err404 = new Error('Error code 404')
    const fn = vi.fn().mockRejectedValue(err404)
    const p = withRetry(fn, { baseDelay: 10, maxRetries: 3 })
    await expect(p).rejects.toThrow('Error code 404')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on generic network-like error', async () => {
    const { withRetry } = useRetry()
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce('ok')
    const p = withRetry(fn, { baseDelay: 10, maxRetries: 3 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
