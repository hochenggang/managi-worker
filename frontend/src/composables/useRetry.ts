// useRetry：通用指数退避重试 composable。
// 修复 v2 网络响应丢失缺陷：HTTP 请求失败直接抛异常无重试。
// 设计见 design-v5.md §6.2。

import { ref } from 'vue'

export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 3。 */
  maxRetries?: number
  /** 初始退避毫秒，默认 1000。 */
  baseDelay?: number
  /** 退避上限毫秒，默认 30000。 */
  maxDelay?: number
  /** 判断错误是否可重试，默认只重试网络错误与 5xx。 */
  shouldRetry?: (err: unknown) => boolean
}

export function useRetry() {
  const retrying = ref(false)

  async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const maxRetries = opts.maxRetries ?? 3
    const baseDelay = opts.baseDelay ?? 1000
    const maxDelay = opts.maxDelay ?? 30000
    const shouldRetry = opts.shouldRetry ?? defaultShouldRetry

    let attempt = 0
    while (true) {
      try {
        const result = await fn()
        retrying.value = false
        return result
      } catch (err) {
        if (attempt >= maxRetries || !shouldRetry(err)) {
          retrying.value = false
          throw err
        }
        // retrying 在 sleep 期间为 true，重试 fn() 期间也保持 true，
        // 仅在成功或最终失败时置 false（修复 A12：finally 每次迭代重置导致 spinner 闪烁）
        retrying.value = true
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay)
        await sleep(delay)
        attempt++
      }
    }
  }

  return { retrying, withRetry }
}

function defaultShouldRetry(err: unknown): boolean {
  // 4xx 不重试，仅重试网络错误与 5xx
  if (err instanceof Response) {
    return err.status >= 500
  }
  if (err instanceof Error) {
    // 用正则精确匹配 "Error code NNN"，替代脆弱的 startsWith + replace
    const m = err.message.match(/^Error code (\d+)$/)
    if (m) return parseInt(m[1]) >= 500
  }
  return true // 网络错误（TypeError: Failed to fetch）默认重试
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
