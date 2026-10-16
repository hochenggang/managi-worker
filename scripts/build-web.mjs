// 构建前端单文件产物到仓库根的 ./dist。
//
// 为什么要单独一个脚本，而不是 package.json 里一行 `cd frontend && npm install && npm run build`：
//   1. wrangler 每次 dev / deploy 都会跑 [build] command，反复对依赖树做 reconcile
//      既慢，也容易在不那么宽松的文件系统环境里被删文件的动作绊住（实测踩过）；
//   2. `test -d` 之类的写法在 Windows 的 cmd 里不存在，而 npm 脚本在 Windows 走 cmd。
// 所以：依赖在就跳过安装，不在（全新克隆 / CI）才装。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = join(dirname(dirname(fileURLToPath(import.meta.url))), 'frontend');

function run(args) {
  // Windows 上 npm 是 npm.cmd，不经壳层直接 spawn 会 ENOENT
  const result = spawnSync('npm', args, {
    cwd: frontend,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(frontend, 'node_modules', 'vite'))) {
  console.log('[build-web] frontend/node_modules 不存在，先安装依赖');
  // --include=dev：CI 常把 NODE_ENV 设成 production，那会让 vite 这类 devDependency 被跳过
  run(['install', '--include=dev', '--no-audit', '--no-fund']);
}

run(['run', 'build']);
