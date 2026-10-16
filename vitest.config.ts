// 单测配置。
//
// 这里刻意**不用** @cloudflare/vitest-pool-workers：整套测试的目标是「把业务逻辑钉住，
// 且随时能在本机跑通」。真起 workerd 会把测试变成「需要一个能出网、能起 sshd 的环境」，
// 那就不再是单测了。所以：
//   · cloudflare:sockets 换成桩（唯一接触它的模块是 dial.ts，行为在用例里注入）；
//   · WebSocketPair / WebSocket.OPEN 这类 workerd 全局在 setup 里补上最小实现；
//   · src/ssh/ 是逐字保留的第三方协议栈，不计入覆盖率分母（它要真实 SSH 服务端才有意义）。
//
// 关于 session.ts 的覆盖率数字：这个文件同时装着「逐字保留的 SSHConnection」与
// 「本项目自写的 PTY / SFTP / Exec 三个通道处理器」。前者与本文件顶部排除的 src/ssh/
// 同性质（要真实服务端才有意义），后者才是会出错的部分。分成两份文件会让覆盖率分母更
// 好看，但会把一段可追溯来源的协议栈代码拆散。所以保持不拆，读数字时按类看：
// SSHConnection ≈ 20%、PTYHandler ≈ 99%、SFTPHandler ≈ 89%、ExecHandler = 100%。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': fileURLToPath(new URL('./tests/stubs/sockets.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/ssh/**'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
