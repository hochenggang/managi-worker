// Pinia store：全局用户设置。
// 支持主题、界面语言、终端字号与终端字体族的持久化；字体族只认内嵌清单里的值。

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeName = 'nord' | 'nord-light' | 'github-dark' | 'github-light'

// 系统等宽字体栈，逐项覆盖 Win/macOS/Linux 上的终端字体，最后落到 generic monospace。
// 必须是等宽：xterm 用 measureText('W') 量出一个格子宽就给所有字形复用，比例字体会让
// 窄字形被 letter-spacing 撑开（main.css 里 body 的 UI 栈是比例字体，不能拿给终端用）。
const SYSTEM_MONO_FAMILY =
  "'Cascadia Mono', Consolas, Menlo, Monaco, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace"

export interface TerminalFontOption {
  // i18n key，由设置页翻译；这里只存 key，避免 store 依赖 i18n 实例。
  labelKey: string
  // 直接交给 xterm 的 font-family。内嵌字体在前，系统等宽栈兜底。
  fontFamily: string
}

// 终端字体的唯一清单：设置页的 <select> 渲染它，store 的校验也用它。
// 名字对应 src/assets/fonts.css 里的 @font-face（随单文件构建内嵌为 data: URI）。
export const TERMINAL_FONT_OPTIONS: readonly TerminalFontOption[] = [
  { labelKey: 'settings.terminal.fonts.jetbrains', fontFamily: `'Managi JetBrains Mono', ${SYSTEM_MONO_FAMILY}` },
  { labelKey: 'settings.terminal.fonts.oldtimey', fontFamily: `'Managi OldTimeyCode', ${SYSTEM_MONO_FAMILY}` },
  { labelKey: 'settings.terminal.fonts.honchoko', fontFamily: `'Managi Honchoko Mono', ${SYSTEM_MONO_FAMILY}` },
  { labelKey: 'settings.terminal.fonts.system', fontFamily: SYSTEM_MONO_FAMILY },
]

const TERMINAL_FONT_FAMILIES = new Set(TERMINAL_FONT_OPTIONS.map((o) => o.fontFamily))

/**
 * waitForTerminalFont 等字体族真正可用（内嵌字体是 data: URI，浏览器要先解码才生效）。
 * 没有 FontFaceSet 的环境直接兑现——调用方只需把这当成「可以重算宽高」的信号。
 */
export function waitForTerminalFont(family: string, size: number): Promise<void> {
  const fonts = document.fonts
  if (typeof fonts?.load !== 'function') return Promise.resolve()
  return fonts.load(`${size}px ${family}`).then(
    () => undefined,
    () => undefined, // 加载失败也继续：调用方顶多多重排一次，不该卡在等字体上
  )
}

export interface Settings {
  theme: ThemeName
  language: 'zh' | 'en'
  terminalFontSize: number
  terminalFontFamily: string
}

const STORAGE_KEY = 'managi-settings'

const defaults: Settings = {
  theme: 'nord',
  language: 'zh',
  terminalFontSize: 14,
  terminalFontFamily: TERMINAL_FONT_OPTIONS[0].fontFamily,
}

function loadSettings(): Settings {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return { ...defaults }
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>
    const merged = { ...defaults, ...parsed }
    if (!isValidTheme(merged.theme)) {
      merged.theme = defaults.theme
    }
    // 旧版本存下的自定义字体串不在清单里，归到默认值，否则设置页的下拉会是空白
    if (!isTerminalFontFamily(merged.terminalFontFamily)) {
      merged.terminalFontFamily = defaults.terminalFontFamily
    }
    return merged
  } catch {
    return { ...defaults }
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(loadSettings())

  function setTheme(theme: ThemeName): void {
    settings.value.theme = theme
    applyTheme(theme)
  }

  function setLanguage(language: 'zh' | 'en'): void {
    settings.value.language = language
  }

  function setTerminalFontSize(size: number): void {
    settings.value.terminalFontSize = Math.max(8, Math.min(32, size))
  }

  function setTerminalFontFamily(family: string): void {
    if (isTerminalFontFamily(family)) {
      settings.value.terminalFontFamily = family
    }
  }

  function importSettings(partial: Partial<Settings>): void {
    if (isValidTheme(partial.theme)) {
      setTheme(partial.theme)
    }
    if (partial.language === 'zh' || partial.language === 'en') {
      setLanguage(partial.language)
    }
    if (typeof partial.terminalFontSize === 'number') {
      setTerminalFontSize(partial.terminalFontSize)
    }
    if (typeof partial.terminalFontFamily === 'string') {
      setTerminalFontFamily(partial.terminalFontFamily)
    }
  }

  function reset(): void {
    settings.value = { ...defaults }
    applyTheme(defaults.theme)
  }

  watch(
    settings,
    (val) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    },
    { deep: true },
  )

  // 初始化时应用主题
  applyTheme(settings.value.theme)
  // 预热当前终端字体：终端往往在应用启动后才打开，提前解码就不会出现
  // 「首帧按兜底字体渲染、字体落地后跳一下」
  void waitForTerminalFont(settings.value.terminalFontFamily, settings.value.terminalFontSize)

  return {
    settings,
    setTheme,
    setLanguage,
    setTerminalFontSize,
    setTerminalFontFamily,
    importSettings,
    reset,
  }
})

const THEME_CLASSES: ThemeName[] = ['nord', 'nord-light', 'github-dark', 'github-light']

function applyTheme(theme: ThemeName): void {
  document.documentElement.classList.remove(...THEME_CLASSES.map((t) => `theme-${t}`))
  document.documentElement.classList.add(`theme-${theme}`)
}

function isValidTheme(theme: ThemeName | undefined): theme is ThemeName {
  return theme !== undefined && THEME_CLASSES.includes(theme)
}

function isTerminalFontFamily(family: unknown): family is string {
  return typeof family === 'string' && TERMINAL_FONT_FAMILIES.has(family)
}
