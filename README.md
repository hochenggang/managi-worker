# managi-worker

**在 Cloudflare Workers 上跑自己的 Web SSH 工作台。**

浏览器直接用 SSH 连你的服务器，Worker 只做中转：凭据跟着请求走一趟就被丢掉，不落任何存储，也不需要你额外养一台跳板机。

> 这是 [managi-v3](https://github.com/hochenggang/managi-v3)（Go 后端 + Vue3 前端）的 Cloudflare Workers 移植版，SSH 协议栈基线来自 [EdgeSSH](https://github.com/aozorae/EdgeSSH)，并按本项目需要持续改进（差异见 `src/ssh/VENDOR.md`）。前端一行没改，重写的只有后端通讯层。
>
> [English](README-en.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/managi-worker)

## 三步用起来

### 1. 部署

点上面的按钮就行：它会把仓库克隆到你的账户，自动建好 KV 命名空间并把 ID 注入配置，Durable Object 由 `wrangler.toml` 里的迁移声明自动建立 —— 你不用手填任何 ID。

想手动来也可以：

```bash
npm install
npx wrangler login
npm run deploy
```

### 2. 设访问口令

部署页上如果出现了 `MANAGI_AUTH` 输入框，就在那里填上。漏了、或者事后想改，去 Cloudflare 控制台 → 你的 Worker → **Settings → Variables and Secrets** 添加：

| 变量名 | 类型 | 值 |
| --- | --- | --- |
| `MANAGI_AUTH` | Secret（推荐） | `用户名:密码`，例如 `ops:my-long-password` |

保存后立刻生效，不用重新部署。

> ⚠️ **不设这个变量，服务直接拒绝全部请求（503）。** 这是默认拒绝：忘配一次，这台 Worker 就是任何人借来连你机器的跳板，而「只打一条警告」帮不了你。
>
> 确认就是要公开访问（比如放在内网里），把它设成 `off`（或 `none`）—— 这是需要主动敲下来的决定。
>
> 值里没有冒号时，整串会被当成密码，用户名回退为 `admin`（与 Go 版一致）。

### 3. 打开页面

访问 `https://<你的 Worker>.workers.dev`，浏览器会弹账号密码框 —— 填上一步设的口令。进去后在左侧节点列表填服务器地址、端口、用户名和密码（或私钥），就能开终端和文件管理了。

## 本地跑

```bash
npm install
npm run dev      # http://localhost:8787
```

本地也必须带口令 —— 默认就是拒绝。把 `.dev.vars.example` 复制成 `.dev.vars`，或者直接内联：

```bash
npx wrangler dev --var MANAGI_AUTH:ops:s3cret
```

本地确实不想鉴权，就显式设成 `off`（别留空）。

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地起服务（会先构建前端） |
| `npm run deploy` | 部署到 Cloudflare |
| `npm test` | 跑单元测试（459 项，约 6 秒，不需要出网） |
| `npm run test:coverage` | 单测 + 覆盖率报告（看 `coverage/index.html`） |
| `npm run test:live` | 拿**真** SSH 服务器跑一次完整握手（需要 `LIVE_SSH_*` 变量，默认跳过） |
| `npm run typecheck` | TypeScript 类型检查（源码 + 测试两套配置） |
| `npm run check` | 类型检查 + 单测 + 试打包 |

## 和 Go 版不一样的地方

移植目标是「稳定简单」，于是砍掉了 Go 版一些为长期运行而生的机制。下面四条必须知道：

| 差异 | 说明 |
| --- | --- |
| **不复用连接** | Go 版按节点维护连接池，同主机的多个标签共用一条 SSH 连接；这里是一路通道一条连接，通道关掉连接就关。好处是一条卡死的通道绝不会牵动别的标签，代价是同一台机器的多个标签各做一次握手。 |
| **不恢复会话** | 断开 WebSocket 即销毁所有通道，重连拿到的是全新 shell。页面刷新后原来终端里跑的东西就没了。 |
| **只能连公网** | 目标地址解析后逐个检查，私网 / 回环 / 保留地址一律拒绝（防 SSRF），并且用解析出的 IP 直接建连（防 DNS rebinding）。连不了 `10.x`、`192.168.x`、`127.0.0.1` 这类地址。 |
| **私钥限未加密 OpenSSH 格式** | 只认 `-----BEGIN OPENSSH PRIVATE KEY-----` 开头、没口令的私钥（Ed25519 / RSA / ECDSA）。带口令的先 `ssh-keygen -p -m OPENSSH -f <私钥文件>` 去掉口令再导入。 |

还有一个实现细节：主机密钥记在 KV 里（TOFU），Go 版记在 `~/.managi/known_hosts`。

## 安全边界

- **凭据不落盘** —— 节点密码 / 私钥只出现在 `open` 帧里，认证一结束就从内存抹掉；既不入 KV，也不入 Durable Object 存储。
- **凭据不进 URL** —— 终端与文件收发共用一条 `/ws` 连接，凭据只在 `open` 帧出现一次，不会落进浏览器历史或访问日志。
- **主机密钥校验（TOFU）** —— 这是唯一挡住中间人的机制。凭据是每个请求现带的，一旦连到假服务器就等于把密码交出去。默认为 `tofu`；把 `HOST_KEY_MODE` 改成 `off` 可以关掉，但只建议调试时这么做。
- **访问口令是两道** —— 除了 HTTP Basic Auth，首次认证成功还会下发一枚 HttpOnly 的签名 Cookie。原因很实在：浏览器不保证给 WebSocket 握手带上已缓存的 Basic 凭据，而 `/ws` 一旦 401，页面看着正常却一个终端都开不出来。Cookie 值是 `过期时间戳.HMAC(时间戳)`，密钥由 `MANAGI_AUTH` 派生 —— **改口令即作废所有已发 Cookie**，服务端不需要任何撤销表。
- **拦跨站 WebSocket 劫持** —— `/ws` 校验 `Origin` 必须与自身同源。
- **默认拒绝** —— `MANAGI_AUTH` 没配就不服务（503 + 配置指引），要公开访问必须显式写 `off`。
- **首连信任要能被看见** —— TOFU 首次记录的主机指纹会随 `open` 响应回给前端，界面提示一次，让人有机会核对。之前它是静默发生的，而那正是中间人最舒服的位置。
- **文件收发只有一条路** —— 上传与下载都走 `/ws` 的数据面，与终端共用同一条已认证的连接。没有第二条 HTTP 通道，也就不存在第二套要维护的鉴权、超时与 Range 语义。
- **硬上限** —— 单条 WebSocket 16 路通道、目录列表 10000 条（超出会明说「只显示了一部分」）、递归删除 / 清残片读目录 10000 条（超出直接报错，不返回半份列表）、递归删除 64 层、**单文件上传与下载各 10MB**、单个数据帧 1MB。上限不是怕慢，是挡住「一个文件把 isolate 或浏览器标签页的内存吃光」。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 修完重新部署，现象照旧 | 先访问 `/api/version`（要口令），看 `deploy.timestamp` 是不是这次部署的时间。还是旧时间就说明改动没上去——「代码没改对」和「改动没部署」从这里一眼分开，不用靠猜。 |
| 一直弹账号密码框，怎么填都进不去 | `MANAGI_AUTH` 没配对。它是 Secret，改完等几秒生效；值必须是 `用户名:密码` 两段。 |
| 页面能开，终端却连不上，日志报「WebSocket 未连接」 | `/ws` 没过口令。硬刷新一次页面，让浏览器重走 Basic 认证、把会话 Cookie 拿到手。 |
| 「已禁用私网/保留地址作为 SSH 目标」 | 设计如此。要连内网机器，请把它暴露到公网（并配好防火墙），或在服务器上开个反向通道。 |
| 「主机密钥与记录不一致」 | 服务器真换过密钥（重装系统、换主机商）就去 **Storage & Databases → KV** 删掉键 `hostkey:example.com:22`，下次连接重新记录；不确定就先确认网络环境，别急着删。 |
| 打开页面直接 503「未配置访问口令」 | `MANAGI_AUTH` 没设，服务默认拒绝。设成 `用户名:密码`；确认要公开访问就设成 `off`。 |
| 「首次连接已记录主机指纹 …」 | TOFU 第一次连接这台机器，刚把指纹记下来。核对一下与服务器 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 是否一致即可。 |
| 「SSH 握手超时」 | 端口不通、防火墙拦了，或对端 SSH 太老（不支持 curve25519 / ecdh-nistp256）。 |
| 「不支持的 SFTP 版本」 | sshd 的 SFTP 子系统不是 v3；把 `Subsystem sftp` 换成 `internal-sftp` 即可。 |
| 「文件 12.4MB，超过下载上限 10MB」 | 单文件上限就是 10MB，上传下载同一口径。更大的文件请在终端里用 `scp` / `rsync` 传 —— Worker 只负责编排，不当大文件中转。 |
| 上传大文件后目录里留下 `xxx.part` | 那是断点续传的残片。同身份（同名同大小同修改时间）续传会接上；确认不要就直接删。 |

看日志：Cloudflare 控制台 → 你的 Worker → **Logs**（实时），或本地 `npm run dev` 的终端输出。

## 目录结构

```
managi-worker/
├── src/
│   ├── worker.ts          # 入口：口令闸 + /ws + /api/version + 静态资源兜底
│   ├── durable-object.ts  # 一条 WebSocket = 一个 DO：通道表、分发、按通道串行化
│   ├── session.ts         # SSH 传输编排：握手、认证、通道生命周期、对外 API
│   ├── handlers.ts        # 两种通道处理器：PTY / SFTP
│   ├── outbound.ts        # 往通道写字节的串行队列（PTY 与 SFTP 共用）
│   ├── log.ts             # 结构化事件日志（一条事件一行 JSON）
│   ├── dial.ts            # 建连：全工程唯一接触 cloudflare:sockets 的地方
│   ├── auth.ts            # 访问口令：Basic Auth + 自签名会话 Cookie
│   ├── node.ts            # 节点校验与配置转换
│   ├── security.ts        # SSRF 防护：DNS 解析后逐个拒绝私网 / 保留段
│   ├── host-keys.ts       # TOFU 主机密钥，落 KV
│   ├── protocol.ts        # 前后端协议（控制帧 + 二进制帧）
│   ├── file-meta.ts       # 目录项的值变换与上传残片命名
│   ├── util.ts            # 通用纯函数
│   ├── types.ts           # SSH 常量、连接配置、Env
│   └── ssh/               # SSH 协议栈（基线 EdgeSSH，差异见 VENDOR.md）
├── tests/                 # 单元测试（跑在 Node 里，不起 workerd）
│   └── live/              # 对真服务器 / 本地 paramiko 服务端的互通验证（默认跳过）
├── frontend/              # 前端，与 managi-v3/frontend 逐字节一致（仅 vite.config.ts 改构建输出）
├── scripts/build-web.mjs  # 构建前端单文件产物到 ./dist
├── wrangler.toml
└── package.json
```

## 开发备注

- **测试跑在 Node 里，不起 workerd** —— 所以不需要出网、不需要有 sshd 可连。被测的是编排逻辑：`cloudflare:sockets` 用 alias 换成桩（唯一触点是 `dial.ts`），`SSHConnection` 与两个通道处理器用 `vi.mock` 整类替换。`src/ssh/**`（协议栈基线）不计入覆盖率分母，它要真实服务端才有意义。
- **协议是硬的** —— 两端（Go 与 Worker）实现同一份契约，前端一字不改地跑在两边，所以改字段必须三处一起改。控制面（文本帧）`{type, data, seq}`：`seq > 0` 一问一答，`seq = 0` 不等回复或服务端主动推；动词 `hello` / `open` / `close` / `resize` / `ping` / `pong` / `error` / `ack` / `exit` / `ls` / `mkdir` / `rm` / `upload` / `upload_end` / `download`。数据面（二进制帧）`[chan: u32 大端][flags: u16 大端][原始字节]`：`FLAG_END = 0x0001` 表示这路流到此结束，`FLAG_STDERR = 0x0002` 表示这一片属于标准错误（只有 exec 会带）。
- **连上先报身份** —— 每条连接第一帧固定是 `hello`：`{protocol, backend, limits}`。`backend` 让人一眼看出连的是 Go 还是 Worker；`protocol` 不符时前端直接停手报错，而不是让「开 exec 通道却没反应」变成一场猜谜。新增的 `hello` / `exit` 动词与 `FLAG_STDERR` 都是协议 v2 的内容。
- **命令跑完 ≠ 出错** —— exec 结束时报 `exit {chan, code}`：`code` 是数字就是真实退出码，`null` 表示服务端没拿到 exit-status。把 `null` 当 0 显示，「被掐断的命令」就会看起来执行成功。
- **`src/ssh/` 是基线，不是禁区** —— 协议栈基线来自 EdgeSSH，但一直在按本项目需要改进：补算法名、加 Encrypt-then-MAC、把易错的位置参数改成具名参数。改什么、为什么改、由谁钉住，全在 [`src/ssh/VENDOR.md`](src/ssh/VENDOR.md) 里；同步上游前先读它。
  - 唯一不能妥协的是**字节布局与报文编号**：这些错了就是「连不上」，一律与规范逐字对齐。
  - 最值得记住的一条：`packet.ts` 的解包回调跑在报文循环里，**回调里不许等「需要下一批入站字节」的结果** —— 那批字节正等着这个循环去消费。SFTP 曾因此每次打开都卡 30 秒。
- **怎么验证协议栈** —— 单测里 `vi.mock` 掉的那个连接对象，恰恰是最可能出问题的那部分，所以关键路径必须在真握手里过一遍。两条路：
  - `npm run test:live` 连**真服务器**（`LIVE_SSH_HOST` / `LIVE_SSH_PORT` / `LIVE_SSH_USER` / `LIVE_SSH_KEY` 指向私钥文件），跑完整握手 + 公钥认证 + 终端里跑一条命令。不设这些变量就自动跳过，所以 `npm test` 始终不出网。
  - `tests/live/etm_server.py` 起一个 paramiko 服务端，把加密算法锁成 `aes128-ctr`、MAC 锁成 `hmac-sha2-256-etm@openssh.com` —— 只有它验证得了 ETM。原因：AEAD 密码下 MAC 一律置 `none`，ETM 根本不会被触发，而现代服务器几乎都提供 AES-GCM；用 paramiko 则是因为它是**独立实现**，自己对自己做往返测试证明不了互通。
- **想同步上游前端** —— 覆盖整个 `frontend/`，再把 `vite.config.ts` 的构建输出改回仓库根的 `./dist`。
