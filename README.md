# managi-worker

在 Cloudflare Workers 上跑一个自己的 Web SSH 工作台。打开网页就能连服务器、开终端、传文件，不用另养一台跳板机，也不用装客户端。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hochenggang/managi-worker)

## 部署

点上面那个按钮。它会把仓库复制到你的 Cloudflare 账户，顺手建好 KV 和 Durable Object —— 不用填任何 ID。

不想用按钮，就在本地跑这三行：

```bash
npm install
npx wrangler login
npm run deploy
```

## 打开就能用

访问 `https://<你的 Worker>.workers.dev`。浏览器会弹登录框，账号和密码都是 `admin`。

进去以后在左边填服务器地址、端口、用户名，再填密码或者私钥，就能开终端和文件管理。

## 然后把默认口令改掉

`admin` / `admin` 是给第一次部署准备的，谁都知道。它能连的是你的服务器，所以请换掉。

Cloudflare 控制台 → 你的 Worker → **Settings → Variables and Secrets** → 添加变量：

- 名称 `MANAGI_AUTH`
- 值写 `用户名:密码`，比如 `ops:my-long-password`

保存就生效，不用重新部署。改完之后所有已登录的会话失效，重新登录一次。

如果这台机器确实可以公开访问（比如只在内网），把值设成 `off`。

## 本地跑

```bash
npm install
npm run dev      # http://localhost:8787
```

本地默认也是 `admin` / `admin`。想换的话，把 `.dev.vars.example` 复制成 `.dev.vars` 再改。

## 常用命令

| 命令 | 做什么 |
| --- | --- |
| `npm run dev` | 本地起服务 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm test` | 单元测试，不出网，几秒钟跑完 |
| `npm run check` | 类型检查 + 单测 + 试打包，提交前跑这个 |
| `npm run test:live` | 连一台真服务器跑完整握手，需要 `LIVE_SSH_*` 变量 |

## 它做不到的事

- **连不了内网。** `10.x`、`192.168.x`、`127.0.0.1` 这类地址会被拒绝，这是防 SSRF 的硬规则。要给内网机器用，得先把它暴露到公网，或者在服务器上开反向通道。
- **单文件最大 10MB。** 上传下载同一口径。更大的文件请在终端里用 `scp` / `rsync`。
- **私钥只支持没口令的 OpenSSH 格式。** 带口令的先 `ssh-keygen -p -m OPENSSH -f <私钥文件>` 去掉。
- **同一台机器的多个标签会各握一次手。** 这里不做连接复用，好处是一个标签卡死不会连累别的。

## 出问题了

| 现象 | 怎么办 |
| --- | --- |
| 改完重新部署，现象照旧 | 打开 `/api/version` 看 `deploy.timestamp` 是不是这次的时间。还是旧的，说明没部署上去。 |
| 登录框怎么填都进不去 | `MANAGI_AUTH` 写错了。必须是 `用户名:密码` 两段，改完等几秒再生效。 |
| 页面能开，终端连不上 | 硬刷新一次页面，让浏览器重新拿到会话 Cookie。 |
| 提示"已禁用私网/保留地址" | 见上面第一条，这是设计如此。 |
| 提示"主机密钥与记录不一致" | 服务器真换过密钥就去 **Storage & Databases → KV** 删掉对应的 `hostkey:...` 键，下次连接重新记录。不确定就先查网络环境，别急着删。 |

看日志：Cloudflare 控制台 → 你的 Worker → **Logs**，或者本地 `npm run dev` 的终端输出。

## 更多

- **[design.md](design.md)** —— 协议怎么走、会话怎么保活、SSH 协议栈改过什么、安全边界在哪、为什么不复用连接。想知道它怎么工作就看这份。
- **[README-en.md](README-en.md)** —— English.

这个项目是 [managi-v3](https://github.com/hochenggang/managi-v3)（Go 后端）的 Cloudflare Workers 版，前端两边是同一份源码，重写的是后端通讯层。SSH 协议栈基线来自 [EdgeSSH](https://github.com/aozorae/EdgeSSH)，改动记在 [`src/ssh/VENDOR.md`](src/ssh/VENDOR.md)。
