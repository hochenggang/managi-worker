import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore, TERMINAL_FONT_OPTIONS, waitForTerminalFont } from '@/stores/settingsStore'

const STORAGE_KEY = 'managi-settings'

// 最后一项是「系统等宽字体」，其余内嵌字体都必须以它为兜底
const SYSTEM_MONO_FAMILY = TERMINAL_FONT_OPTIONS[TERMINAL_FONT_OPTIONS.length - 1].fontFamily

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('终端字体选项', () => {
  it('四个选项，全部以系统等宽字体栈兜底', () => {
    expect(TERMINAL_FONT_OPTIONS).toHaveLength(4)
    for (const option of TERMINAL_FONT_OPTIONS) {
      expect(option.fontFamily.endsWith(SYSTEM_MONO_FAMILY)).toBe(true)
    }
  })

  // 比例字体（system-ui/Segoe UI 等）会让 xterm 的 measureText('W') 量出过宽的格子，
  // 渲染时窄字形被 letter-spacing 撑开；兜底必须以 generic monospace 结尾。
  it('兜底栈是等宽的，不会退到比例字体', () => {
    for (const option of TERMINAL_FONT_OPTIONS) {
      expect(option.fontFamily.trim().endsWith('monospace')).toBe(true)
      expect(option.fontFamily).not.toMatch(/system-ui|sans-serif|-apple-system/)
    }
  })

  it('前三项是内嵌字体，排在兜底栈之前', () => {
    const embedded = TERMINAL_FONT_OPTIONS.slice(0, 3).map((o) => o.fontFamily)
    expect(embedded.every((f) => f.startsWith("'Managi "))).toBe(true)
  })

  it('没有存档时使用清单第一项', () => {
    expect(useSettingsStore().settings.terminalFontFamily).toBe(TERMINAL_FONT_OPTIONS[0].fontFamily)
  })
})

describe('旧存档里的自定义字体串', () => {
  it('不在清单内则归到默认值，避免下拉渲染成空白', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminalFontFamily: "'JetBrains Mono', 'Fira Code', monospace" }),
    )
    setActivePinia(createPinia())
    expect(useSettingsStore().settings.terminalFontFamily).toBe(TERMINAL_FONT_OPTIONS[0].fontFamily)
  })

  it('setter 忽略清单外的字体族', () => {
    const store = useSettingsStore()
    store.setTerminalFontFamily("'Comic Sans MS', cursive")
    expect(store.settings.terminalFontFamily).toBe(TERMINAL_FONT_OPTIONS[0].fontFamily)
  })

  // happy-dom 没有 FontFaceSet：等字体必须照常兑现，否则终端的重测路径在测试里永远走不到
  it('没有 FontFaceSet 时 waitForTerminalFont 立即兑现', async () => {
    await expect(
      waitForTerminalFont(TERMINAL_FONT_OPTIONS[0].fontFamily, 14),
    ).resolves.toBeUndefined()
  })
})
