import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Notifications from '@kyvg/vue3-notification'
import { autoAnimatePlugin } from '@formkit/auto-animate/vue'

import App from './App.vue'
import { i18n } from './i18n'

// 应用入口：注册全部插件。界面为单页多标签，无需路由。
const app = createApp(App)

app.use(createPinia())
app.use(Notifications)
app.use(autoAnimatePlugin)
app.use(i18n)

app.mount('#app')
