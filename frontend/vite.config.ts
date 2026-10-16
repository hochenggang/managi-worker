/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Vite 配置：保留 v2 的 singlefile + alias，便于 Tauri 内嵌与后端静态服务。
// 设计见 design-v5.md §2.2 与 §5.1。
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    viteSingleFile(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: '/',
  // Worker 版把单文件产物输出到仓库根的 ./dist，直接挂给 wrangler 的 [assets] 绑定。
  // 目录在 root 之外，必须显式声明 emptyOutDir，否则 Vite 会跳过清空并告警。
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/__tests__/**'],
    },
  },
})
