// useWSHub：一条 /ws 连接的共享枢纽。
//
// 页面里所有标签共用这一条连接：每路终端 = 一路 PTY 通道，每路文件管理 = 一路 SFTP 通道。
// 枢纽只管三件事：
//   1. 连接生命周期——心跳、响应看门狗、指数退避重连、重连后重开各通道；
//   2. 帧路由——控制帧按 seq 了结等待中的请求，数据帧按 chan 投递给所属通道；
//   3. 输入窗口账本——服务端 ack 推进窗口，发送方向（粘贴/上传）按 waitAck 节流。
// 业务语义（终端输入、目录操作、字节缓冲）都留在调用方，枢纽一概不知。
// 协议见 ./../protocol/ws.ts 与 ./../protocol/frames.ts，后端为 handler/ws.go。

import { ref, type Ref } from 'vue'
import { getApiBase } from '@/api'
import { toErrorMessage } from '@/helper'
import { decodeFrame, encodeFrame } from '@/protocol/frames'
import {
  decodeEnvelope,
  encodeEnvelope,
  type AckData,
  type Envelope,
  type ErrorData,
  type OpenPayload,
  type OpenResponse,
  type RequestData,
  type Verb,
} from '@/protocol/ws'

/** 连接状态（链路层）。connected 只代表 WS 握手成功，通道能不能用看 ChannelState。 */
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** 通道状态。opening：open 请求在途，或重连后待重开。 */
export type ChannelState = 'opening' | 'open' | 'error'

/** 一路通道的行为规范：怎么重开、字节到了怎么办。 */
export interface ChannelSpec {
  /** 重开本通道所需的 open 负载。取函数而非值：重连后尺寸等参数可能已变。 */
  openData: () => OpenPayload
  /** 通道就绪：首次打开与每次重连后各一次，resp.chan 是这条新连接上的通道号。 */
  onOpen: (resp: OpenResponse) => void
  /** 本通道的数据帧到达。end=true 表示这路流结束（载荷可为空）。 */
  onData: (payload: Uint8Array, end: boolean) => void
  /** 服务端主动推的控制帧（seq=0）：error / upload_end。 */
  onNotify: (type: Verb, data: unknown) => void
}

export interface Channel {
  readonly state: Ref<ChannelState>
  /** 一问一答：自动带上本通道的 chan；响应按 seq 匹配，超时或断线则 reject。 */
  request: <T>(type: Verb, data?: RequestData, timeoutMs?: number) => Promise<T>
  /** 不等回复的控制帧（resize 这类高频、漂一点无所谓的事）。 */
  notify: (type: Verb, data?: RequestData) => boolean
  /** 数据面单帧。链路未就绪返回 false，由调用方缓冲后重试。 */
  frame: (payload: Uint8Array, end?: boolean) => boolean
  /** 等输入窗口腾出 bytes 字节：上传与粘贴按服务端 ack 节流，慢链路不堆内存。
   *  断链、通道出错、摘除时立即放行，让调用方尽快回到 frame()/错误检查上。 */
  waitAck: (bytes: number) => Promise<void>
  /** 摘除本通道：服务端随之释放其资源（PTY 的 shell 按空闲 TTL 保留，可再复用）。 */
  close: () => void
}

export interface Hub {
  readonly status: Ref<ConnectionStatus>
  attach: (spec: ChannelSpec) => Channel
  /** 释放连接与全部定时器（单测与页面卸载用）。 */
  dispose: () => void
}

const HEARTBEAT_MS = 15_000
// 发出 ping 后这么久没有任何入站帧即判定连接已死：半开 TCP 只能靠主动探测发现。
// 只由心跳授权，不由数据帧授权——上传时分片本来就无需逐片回复，等不到响应是常态。
const RESPONSE_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
// open 可能包含拨号、认证、起 shell，给足预算；超时后由重连再试。
const OPEN_TIMEOUT_MS = 120_000
const MAX_RECONNECT = 10
// open 响应没有 window 时的兜底窗口（老服务端/协议漂移）：与后端默认值同量级，
// 只影响发送节流精度，不影响正确性——服务端队列预算独立于它。
const FALLBACK_INPUT_WINDOW = 8 << 20

function hubUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${getApiBase().replace(/^https?:\/\//, '')}/ws`
}

interface Binding {
  spec: ChannelSpec
  /** 当前连接上的通道号；0 = 尚未就绪（服务端从 1 起分配）。 */
  chan: number
  state: Ref<ChannelState>
  /** 本通道发出的、尚未了结的请求 seq：摘除通道时据此一并失败，不留悬等 Promise。 */
  pending: Set<number>

  // 输入窗口账本（发送方向流控）：占用 = sent - acked，超过 window 就等 ack 滑动。
  // sent 是本通道数据面已发出的字节，acked 是服务端 ack 里的累计值（含丢弃补偿）。
  window: number
  sent: number
  acked: number
  ackWaiters: Set<AckWaiter>
}

/** AckWaiter 在等窗口的挂起者：need 是它要发送的字节数。 */
interface AckWaiter {
  need: number
  resolve: () => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  owner?: Binding
}

/** createHub 建一个枢纽。整页用 useWSHub() 的单例；导出工厂是为了单测各建一个实例，
 *  不必与模块级状态和别的测试文件互相污染。
 */
export function createHub(url = hubUrl()): Hub {
  const status = ref<ConnectionStatus>('idle')
  const bindings = new Set<Binding>()
  const byChan = new Map<number, Binding>()
  const pending = new Map<number, Pending>()

  let ws: WebSocket | null = null
  let seqCounter = 0
  let reconnectAttempts = 0
  // 曾经连上过：区分「首次连接」与「重连」，UI 文案与状态机都据此选边
  let everConnected = false
  let stopped = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null

  // ===== 链路 =====

  function connect(): void {
    if (stopped) return
    if (reconnectTimer) {
      // 已有待触发的重连：这次直接连，不必再等退避
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) return // 正在连接或已连接
    status.value = everConnected ? 'reconnecting' : 'connecting'
    const conn = new WebSocket(url)
    conn.binaryType = 'arraybuffer'
    ws = conn

    conn.onopen = () => {
      if (ws !== conn) return
      everConnected = true
      reconnectAttempts = 0
      status.value = 'connected'
      startHeartbeat()
      // 各通道并行重开：open 请求各带自己的 seq，互不抢答
      for (const b of bindings) void reopen(b)
    }
    conn.onmessage = (ev: MessageEvent) => {
      clearWatchdog() // 任何入站帧都证明连接活着
      if (typeof ev.data === 'string') handleControl(ev.data)
      else handleBinary(ev.data as ArrayBuffer)
    }
    // onerror 不单独处理：浏览器随后必发 onclose，最终状态由它决定。
    conn.onclose = (ev: CloseEvent) => {
      console.warn('[useWSHub] 连接关闭', ev.code, ev.reason)
      if (ws === conn) ws = null
      onLinkLost()
      scheduleReconnect()
    }
  }

  /** onLinkLost 链路断开：在途请求全部作废，通道退回 opening 等重连后重开。 */
  function onLinkLost(): void {
    stopHeartbeat()
    clearWatchdog()
    failPending(new Error('连接已断开'))
    byChan.clear()
    for (const b of bindings) {
      b.chan = 0
      b.pending.clear()
      // 窗口账本随连接归零：新连接上的通道是全新的，ack 从 0 重新计。
      // 等窗口的挂起者一并放行——调用方会在下一次 frame() 上拿到 false 并缓冲等待。
      b.sent = 0
      b.acked = 0
      releaseAckWaiters(b)
      if (b.state.value === 'open') b.state.value = 'opening'
    }
  }

  /** dropAndReconnect 主动掐断链路并重连：心跳无响应、字节流错位都走这里。
   *  先摘掉回调再关，避免旧 socket 的 onclose 与新连接互相踩状态。
   */
  function dropAndReconnect(reason: string): void {
    console.warn(`[useWSHub] ${reason}`)
    const conn = ws
    ws = null
    if (conn) {
      conn.onopen = null
      conn.onmessage = null
      conn.onclose = null
      conn.onerror = null
      conn.close()
    }
    onLinkLost()
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    if (reconnectAttempts >= MAX_RECONNECT) {
      status.value = 'failed'
      return
    }
    status.value = 'reconnecting'
    // 指数退避 + jitter：多客户端同时掉线时不至于一起冲击服务端
    const base = Math.min(1000 * 2 ** reconnectAttempts, 16_000)
    reconnectAttempts++
    reconnectTimer = setTimeout(connect, base + Math.random() * 500)
  }

  function isOpen(): boolean {
    return ws?.readyState === WebSocket.OPEN
  }

  function sendText(text: string): boolean {
    const conn = ws
    if (!conn || conn.readyState !== WebSocket.OPEN) return false
    conn.send(text)
    return true
  }

  function sendFrame(b: Binding, payload: Uint8Array, end: boolean): boolean {
    const conn = ws
    if (!conn || !b.chan || conn.readyState !== WebSocket.OPEN) return false
    // 窗口外的帧不发出：调用方经 waitAck 等待或先缓冲。客户端因此始终在窗口内，
    // 服务端队列预算（窗口 + 一片余量）对合规客户端永远填不满——溢出只是防线的防线。
    if (!windowOpen(b, payload.byteLength)) return false
    conn.send(encodeFrame(b.chan, payload, end))
    b.sent += payload.byteLength // 计入输入窗口：ack 里的累计值就对着它算占用
    return true
  }

  // ===== 心跳与看门狗 =====

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(ping, HEARTBEAT_MS)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  /** ping 发一个控制面 ping 并授权响应看门狗。
   *  后台标签页跳过：JS 定时器被节流，而服务端每 30s 发协议级 Ping、浏览器自动回 Pong，
   *  连接不会因为前台静默而超时。
   */
  function ping(): void {
    if (document.hidden) return
    if (sendText(encodeEnvelope({ type: 'ping' }))) armWatchdog()
  }

  function armWatchdog(): void {
    clearWatchdog()
    watchdogTimer = setTimeout(
      () => dropAndReconnect('心跳无响应，判定连接已死'),
      RESPONSE_TIMEOUT_MS,
    )
  }

  function clearWatchdog(): void {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = null
  }

  // 回前台立刻探一次并重新对齐心跳周期，不等下一个定时器（后台期间被节流成一分钟一次）。
  const onVisibility = (): void => {
    if (document.hidden || !isOpen()) return
    startHeartbeat()
    ping()
  }
  document.addEventListener('visibilitychange', onVisibility)

  // ===== 控制面 =====

  function request<T>(type: Verb, data: unknown, timeoutMs: number, owner?: Binding): Promise<T> {
    const seq = ++seqCounter
    const env: Envelope = data === undefined ? { type, seq } : { type, data, seq }
    return new Promise<T>((resolve, reject) => {
      if (!sendText(encodeEnvelope(env))) {
        reject(new Error('WebSocket 未连接'))
        return
      }
      const timer = setTimeout(() => abandon(seq, new Error(`${type} 请求超时`)), timeoutMs)
      pending.set(seq, { resolve: resolve as (value: unknown) => void, reject, timer, owner })
      owner?.pending.add(seq)
    })
  }

  /** abandon 撤下一个等待中的请求并给出原因：超时、断线、通道关闭共用这一条出口。 */
  function abandon(seq: number, err: Error): void {
    const p = pending.get(seq)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(seq)
    p.owner?.pending.delete(seq)
    p.reject(err)
  }

  function handleControl(text: string): void {
    const env = decodeEnvelope(text)
    if (!env) return
    if (env.type === 'pong') return // 心跳应答：入站本身已用于续命，无需再分发
    const seq = env.seq ?? 0
    if (seq > 0) settle(seq, env)
    else routeNotification(env)
  }

  /** settle 用响应帧了结等待中的请求。seq 不在表里 = 超时或断线之后才迟到的响应，丢弃。 */
  function settle(seq: number, env: Envelope): void {
    const p = pending.get(seq)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(seq)
    p.owner?.pending.delete(seq)
    if (env.type === 'error') p.reject(new Error(errorText(env.data)))
    else p.resolve(env.data)
  }

  /** routeNotification 把 seq=0 的主动推送投给所属通道（按 data.chan 定位）。
   *  ack 在枢纽就地消化（窗口账本是枢纽自己的事），其余交业务回调。
   */
  function routeNotification(env: Envelope): void {
    const chan = (env.data as { chan?: number } | undefined)?.chan ?? 0
    const b = chan ? byChan.get(chan) : undefined
    if (!b) {
      console.warn(`[useWSHub] 无法归属的控制帧：${env.type}`)
      return
    }
    if (env.type === 'ack') {
      handleAck(b, env.data)
      return
    }
    b.spec.onNotify(env.type, env.data)
    // 通道级错误：叫醒等窗口的挂起者，让调用方立刻回去看错误状态，
    // 而不是悬在一个可能永远不来的 ack 上（服务端已把该通道判死时尤其如此）。
    if (env.type === 'error') releaseAckWaiters(b)
  }

  // ===== 输入窗口（发送方向流控） =====

  /** handleAck 服务端确认输入字节数：滑动窗口并放行已满足的等待者。
   *  bytes 是「已消费或已作废」的累计值；用 max 吸收终止路径上可能的乱序到达。 */
  function handleAck(b: Binding, data: unknown): void {
    const bytes = (data as AckData | undefined)?.bytes
    if (typeof bytes !== 'number' || bytes <= b.acked) return
    b.acked = bytes
    tryAckWaiters(b)
  }

  /** tryAckWaiters 放行所有已满足的等待者（ack 到达、通道重开后复核）。 */
  function tryAckWaiters(b: Binding): void {
    for (const w of [...b.ackWaiters]) {
      if (windowOpen(b, w.need)) {
        b.ackWaiters.delete(w)
        w.resolve()
      }
    }
  }

  /** windowOpen 本通道再发 need 字节是否仍在窗口内。 */
  function windowOpen(b: Binding, need: number): boolean {
    return b.sent + need - b.acked <= b.window
  }

  /** waitAck 等窗口腾出 need 字节：有余量立即放行，否则登记等待者。 */
  function waitAck(b: Binding, need: number): Promise<void> {
    return new Promise((resolve) => {
      if (windowOpen(b, need)) {
        resolve()
        return
      }
      b.ackWaiters.add({ need, resolve })
    })
  }

  /** releaseAckWaiters 无条件放行全部等待者（断链/出错/摘除）：余量已无意义，
   *  让调用方尽快回到 frame() 或错误检查上，而不是悬在永远不会到的 ack 上。 */
  function releaseAckWaiters(b: Binding): void {
    for (const w of b.ackWaiters) w.resolve()
    b.ackWaiters.clear()
  }

  function errorText(data: unknown): string {
    return (data as ErrorData | undefined)?.message ?? '未知错误'
  }

  function failPending(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  // ===== 数据面 =====

  function handleBinary(buf: ArrayBuffer): void {
    const f = decodeFrame(buf)
    if (!f) {
      // 连帧头都不完整说明字节流已错位，继续在错误偏移上拼数据只会产出坏文件与乱码
      dropAndReconnect('收到畸形数据帧，重连恢复')
      return
    }
    byChan.get(f.chan)?.spec.onData(f.payload, f.end)
  }

  // ===== 通道 =====

  /** reopen 在（重）连上的连接上重建一路通道。失败不重试：出声交给调用方，
   *  链路再断时会整体重开，用户重开标签页也能再来一次。
   */
  async function reopen(b: Binding): Promise<void> {
    if (b.chan) byChan.delete(b.chan)
    b.chan = 0
    b.state.value = 'opening'
    try {
      const resp = await request<OpenResponse>('open', b.spec.openData(), OPEN_TIMEOUT_MS, b)
      if (!bindings.has(b)) return // 等待期间已被摘除
      if (!resp?.chan) throw new Error('open 响应缺少 chan')
      b.chan = resp.chan
      byChan.set(b.chan, b)
      // 新通道 = 新窗口账本：ack 从 0 重新计。等窗口的挂起者在此复核——
      // 缓冲输入的重连补发（断线时登记的等待者）走的就是这条路。
      b.window = resp.window && resp.window > 0 ? resp.window : FALLBACK_INPUT_WINDOW
      b.sent = 0
      b.acked = 0
      b.state.value = 'open'
      tryAckWaiters(b)
      b.spec.onOpen(resp)
    } catch (e) {
      b.state.value = 'error'
      releaseAckWaiters(b) // 开不起来时别让发送循环悬在窗口上，它会立刻看到错误状态
      // 开不起来必须出声（密码错、目标不可达），否则用户只看到一直「正在连接」
      b.spec.onNotify('error', { message: toErrorMessage(e) })
    }
  }

  function detach(b: Binding): void {
    if (!bindings.delete(b)) return
    for (const seq of b.pending) abandon(seq, new Error('通道已关闭'))
    b.pending.clear()
    releaseAckWaiters(b) // 通道没了，等窗口的发送循环到此为止
    if (b.chan) {
      byChan.delete(b.chan)
      // seq 省略：不等回复，组件正在卸载，没人处理应答
      sendText(encodeEnvelope({ type: 'close', data: { chan: b.chan } }))
      b.chan = 0
    }
  }

  function attach(spec: ChannelSpec): Channel {
    const b: Binding = {
      spec,
      chan: 0,
      state: ref<ChannelState>('opening'),
      pending: new Set(),
      window: 0,
      sent: 0,
      acked: 0,
      ackWaiters: new Set(),
    }
    bindings.add(b)
    if (isOpen()) void reopen(b)
    else connect()

    const notReady = () => Promise.reject(new Error('通道尚未就绪'))
    return {
      state: b.state,
      request: <T>(type: Verb, data?: RequestData, timeoutMs?: number): Promise<T> =>
        b.chan
          ? request<T>(type, { ...data, chan: b.chan }, timeoutMs ?? REQUEST_TIMEOUT_MS, b)
          : notReady(),
      notify: (type, data) =>
        !!b.chan && sendText(encodeEnvelope({ type, data: { ...data, chan: b.chan } })),
      frame: (payload, end) => sendFrame(b, payload, end ?? false),
      waitAck: (bytes) => waitAck(b, bytes),
      close: () => detach(b),
    }
  }

  function dispose(): void {
    stopped = true
    document.removeEventListener('visibilitychange', onVisibility)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    const conn = ws
    ws = null
    if (conn) {
      conn.onopen = null
      conn.onmessage = null
      conn.onclose = null
      conn.onerror = null
      conn.close()
    }
    onLinkLost()
    bindings.clear()
    status.value = 'idle'
  }

  return { status, attach, dispose }
}

// 整页一个枢纽：一条 /ws 连接承载全部终端与文件管理标签。
// 懒建：仅取用 uiStatus 这类纯函数时不该去解析 WS 地址。
let shared: Hub | null = null

export function useWSHub(): Hub {
  shared ??= createHub()
  return shared
}

/** uiStatus 把「链路状态 + 通道状态」折成界面用的五态。
 *  通道优先于链路：WS 握手成功不等于 SSH 登录完成，此时显示「已连接」会诱导用户敲命令。
 */
export function uiStatus(
  link: ConnectionStatus,
  chan: ChannelState,
): ConnectionStatus {
  if (link === 'connecting' || link === 'reconnecting' || link === 'failed') return link
  if (link === 'idle') return 'idle'
  if (chan === 'open') return 'connected'
  return chan === 'error' ? 'failed' : 'connecting'
}
