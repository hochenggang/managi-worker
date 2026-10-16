// i18n：vue-i18n 配置，默认中文。
// 与 v2 i18n.ts 一致，locale 资源从 locales 加载。

import { createI18n } from 'vue-i18n'
import zh from './locales/zh.json'
import en from './locales/en.json'

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'zh',
  fallbackLocale: 'en',
  messages: { zh, en },
})
