// 「真实服务器互通测试」的配置。
//
// 与 vitest.config.ts 分开是刻意的：默认的 `npm test` 必须**不需要出网**。
// 这份配置只在显式 `npm run test:live` 时用，且要求 LIVE_SSH_* 环境变量（见 tests/live/interop.live.ts）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.ts'],
    // 跨公网握手，给宽一点。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 互通测试要看清握手细节，别把日志吞掉。
    silent: false,
  },
});
