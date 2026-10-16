import { afterEach, vi } from 'vitest'

// 全局 mock localStorage（api.ts / useWSHub.ts 读取 managi-api-host / cached-nodes）
const localStorageStore: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => localStorageStore[key] ?? null,
    setItem: (key: string, value: string) => { localStorageStore[key] = value },
    removeItem: (key: string) => { delete localStorageStore[key] },
    clear: () => { Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]) },
  },
  writable: true,
})

// 提供 location 基础值（happy-dom 提供，但确保 port 存在）
if (typeof globalThis.location !== 'undefined') {
  if (!globalThis.location.port) {
    Object.defineProperty(globalThis.location, 'port', { value: '8080', writable: true, configurable: true })
  }
}

afterEach(() => {
  vi.clearAllMocks()
  Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k])
})
