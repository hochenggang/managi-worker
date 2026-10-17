# `src/ssh/` 与上游的关系

上游：[EdgeSSH](https://github.com/aozorae/EdgeSSH) 的 `src/ssh/`。

**本目录不是「逐字供奉」的。** 站在它肩膀上，就要按自己的判断改进它。

分界很清楚：

- **报文编号、字节布局、密钥派生、状态机** —— 这些错了就是「连不上」，一律保持原样；
- **表达方式、重复实现、明显不合理的结构** —— 改。改动必须同时满足两条：
  1. 有测试钉住（否则下次同步上游会被静默回退，而症状离修改点很远，极难回溯）；
  2. 能在本文件里说清「为什么」—— 说不出理由的改动，就是噪音。

## 改动清单

| 文件 | 改了什么 | 为什么 | 由谁钉住 |
|---|---|---|---|
| `algorithms.ts` | 补 `curve25519-sha256@libssh.org` 旧名；登记两个 ETM MAC 名与尺寸；新增 `KEX_FAMILIES` 族表 | 旧名与标准名是同一算法（RFC 8731），但协商是精确字符串匹配；ETM 上游没有；族表让「名字 → 实现」只有一处事实 | `tests/algorithms.test.ts`、`tests/ssh-etm.test.ts` |
| `crypto.ts` | `SSHHMAC` 构造器剥掉 `-etm@openssh.com` 后缀再判哈希 | ETM 与同名非 ETM 是同一个 HMAC，只差分帧 | `tests/ssh-etm.test.ts` |
| `packet.ts` | 收发各加一条 ETM 分支；明文阶段拒走 ETM 分帧；`nextPacket` / `build` 改具名参数对象 | ETM 见上。具名参数：原来是「6 个值 + 3 个布尔」的位置参数，把 `macLength` 与 `blockSize` 传颠倒不会有类型错误，只会解出乱码 | `tests/ssh-etm.test.ts` |
| `sftp.ts` | 新增 `lstat()`（LSTAT 报文） | `remove` 要区分「删软链接本身」与「删它指向的目标」，上游只有 `stat` | `tests/session.test.ts` 钉住调用路径；**LSTAT 报文本身尚无真机用例**（`tests/live/sftp.live.ts` 目前只覆盖 open/list） |
| `sftp.ts` | 记住最近了结（成功或超时）的请求号，迟到 / 重复的应答直接丢弃；只有**从未分配过**的请求号才算协议错误 | 上游把所有未知请求号一律当协议错误，调用方 `feed()` 一抛就 dispose 整条通道。慢服务器上「一次读请求超时 → 应答晚到」足以让文件管理页报废，而代价与收益完全不对等 | `tests/sftp.test.ts`（超时后晚到、重复应答、真正陌生的号） |
| `transport.ts` | 客户端标识 `CFWorkersWebSSH_1.0` → `managi_1.0` | 照搬的后果是目标机器的 sshd 日志、`last`、`who` 里显示别人的客户端名，出问题时无法确认「是我连的」 | 常量，无运行时分支 |
| `kex.ts` | 4 处手写大端移位与长度前缀改用 `utils.ts` 的 `readUint32` / `encodeString` | 同一件事原来有 3 套实现（`utils.ts`、`kex.ts` 手写、`sftp.ts` 自有），改一处漏两处 | `tests/algorithms.test.ts`、`tests/protocol.test.ts` |

## 看着像债、其实是升级的地方

`sftp.ts` 自带的 `Reader` 和 `encodeUint32` / `encodeString`（带 `label` 参数）**不要**合并进 `utils.ts`。

它们比 `utils.ts` 多了「这段字段叫什么」的上下文：解析失败时能说出是哪一项越界，而 `utils.ts` 只能抛一个 offset。这个重复是有意的。

## 同步上游的步骤

1. 逐个文件比对上面的清单，确认引入的上游变动没有和清单里的改动打架；
2. `npm test`（单测钉住语义）→ `npm run test:live`（真服务器钉住互通）→ 必要时 `npm run test:live` 之外的 paramiko ETM 用例；
3. 清单有增删就更新本文件。**这个文件过时比没有更糟** —— 它会让人以为「只有这几处」，从而漏掉真正的那处。

## 一条硬约束

`packet.ts` 的 `nextPacket` 收到的回调会在报文循环里执行。**回调里不许 `await` 任何「需要下一批入站字节才能完成」的东西** —— 那个字节正等着这个循环去消费。曾经因此让 SFTP 每次打开都卡 30 秒（`SFTPHandler.onRequestResult` 里等 INIT/VERSION 往返），而 PTY 因为只发不等，从未暴露。见 `src/session.ts` 中 `SSH_MSG_CHANNEL_SUCCESS` 分支的注释。
