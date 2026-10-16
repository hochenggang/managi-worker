import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHub, uiStatus, type Channel, type ChannelSpec } from '@/composables/useWSHub'
import { decodeFrame, encodeFrame, type DataFrame } from '@/protocol/frames'
import type { ApiNode } from '@/protocol/types'
import type { OpenPayload } from '@/protocol/ws'

// 枢纽是 M1 的地基：一条连接的生命周期 + 双平面路由。
// 用假 WebSocket 精确驱动握手、退避重连、心跳与帧序，不碰真实网络。

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static created: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = ''
  sent: Array<string | Uint8Array> = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.created.push(this)
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('socket 未就绪')
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

  // ===== 以下仅由测试调用，模拟服务端行为 =====

  accept(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  reply(env: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(env) })
  }

  push(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer })
  }

  drop(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006, reason: 'gone' })
  }

  /** 已发出的控制帧，按发出顺序 */
  texts(): Array<Record<string, any>> {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s))
  }

  /** 已发出的数据帧 */
  frames(): DataFrame[] {
    return this.sent
      .filter((s): s is Uint8Array => s instanceof Uint8Array)
      .map((b) => decodeFrame(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))!)
  }

  seqOf(index: number): number {
    return this.texts()[index].seq
  }
}

const node: ApiNode = {
  name: 'n1',
  host: '1.2.3.4',
  port: 22,
  username: 'root',
  auth_type: 'password',
  auth_value: 'pwd',
}

interface Recorder {
  spec: ChannelSpec
  onOpen: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  onNotify: ReturnType<typeof vi.fn>
}

function makeSpec(kind: 'pty' | 'sftp' = 'sftp'): Recorder {
  const onOpen = vi.fn()
  const onData = vi.fn()
  const onNotify = vi.fn()
  const openData =
    kind === 'pty'
      ? (): OpenPayload => ({ kind: 'pty', node, session_id: 's1', cols: 80, rows: 24 })
      : (): OpenPayload => ({ kind: 'sftp', node })
  return { spec: { openData, onOpen, onData, onNotify }, onOpen, onData, onNotify }
}

let hub!: ReturnType<typeof createHub>

/** 推进微任务队列：通道重开的回调链全是微任务，不能靠 fake timers 的 setTimeout。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function lastSocket(): FakeSocket {
  return FakeSocket.created[FakeSocket.created.length - 1]
}

/** 走完「握手 → open → 服务端分配 chan」，返回就绪前的通道（调用方需 await tick()）。 */
function attach(rec: Recorder): Channel {
  const channel = hub.attach(rec.spec)
  lastSocket().accept()
  return channel
}

/** 回复最近一个 open 请求（一条连接上可以有多路通道依次重开）。 */
function openReply(sock: FakeSocket, chan: number, extra: Record<string, unknown> = {}): void {
  const envs = sock.texts()
  const seq = envs[envs.map((e) => e.type).lastIndexOf('open')].seq
  sock.reply({ type: 'open', seq, data: { kind: 'sftp', chan, ...extra } })
}

async function attachAndOpen(chan = 1): Promise<{ channel: Channel; sock: FakeSocket; rec: Recorder }> {
  const rec = makeSpec()
  const channel = attach(rec)
  const sock = lastSocket()
  openReply(sock, chan)
  await tick()
  return { channel, sock, rec }
}

/** 同上，但让 open 响应携带指定输入窗口：窗口语义要用小数值才断言得动。 */
async function attachWithWindow(win: number, chan = 1): Promise<{ channel: Channel; sock: FakeSocket; rec: Recorder }> {
  const rec = makeSpec()
  const channel = attach(rec)
  const sock = lastSocket()
  openReply(sock, chan, { window: win })
  await tick()
  return { channel, sock, rec }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0) // 退避 jitter 归零，重连延时可精确断言
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  FakeSocket.created = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  hub = createHub('ws://test/ws')
})

afterEach(() => {
  hub.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createHub：建连与通道生命周期', () => {
  it('attach 首次建连，握手后发出 open，响应到达即就绪', async () => {
    const rec = makeSpec()
    const channel = hub.attach(rec.spec)
    expect(hub.status.value).toBe('connecting')
    expect(FakeSocket.created).toHaveLength(1)
    expect(FakeSocket.created[0].binaryType).toBe('arraybuffer')

    FakeSocket.created[0].accept()
    expect(hub.status.value).toBe('connected')
    expect(FakeSocket.created[0].texts()[0]).toEqual({
      type: 'open',
      seq: 1,
      data: { kind: 'sftp', node },
    })

    openReply(FakeSocket.created[0], 4)
    await tick()
    expect(channel.state.value).toBe('open')
    expect(rec.onOpen).toHaveBeenCalledWith({ kind: 'sftp', chan: 4 })
  })

  it('open 响应缺少 chan 时判为失败：状态 error 且出声', async () => {
    const rec = makeSpec()
    const channel = hub.attach(rec.spec)
    const sock = lastSocket()
    sock.accept()
    sock.reply({ type: 'open', seq: 1, data: { kind: 'sftp' } })
    await tick()
    expect(channel.state.value).toBe('error')
    expect(rec.onNotify).toHaveBeenCalledWith('error', { message: 'open 响应缺少 chan' })
  })

  it('open 被服务端拒绝（认证失败）时错误原文交给通道，不静默卡在连接中', async () => {
    const rec = makeSpec('pty')
    const channel = hub.attach(rec.spec)
    const sock = lastSocket()
    sock.accept()
    sock.reply({ type: 'error', seq: 1, data: { message: 'ssh: rejected' } })
    await tick()
    expect(channel.state.value).toBe('error')
    expect(rec.onNotify).toHaveBeenCalledWith('error', { message: 'ssh: rejected' })
    expect(rec.onOpen).not.toHaveBeenCalled()
  })

  it('close 摘除通道：在途请求立即了结，此后帧发不出也收不到', async () => {
    const { channel, sock, rec } = await attachAndOpen(2)
    const assertion = expect(channel.request('ls', { path: '/x' })).rejects.toThrow('通道已关闭')
    channel.close()
    await assertion
    // texts[1] 是刚被摘除的那个 ls 请求，close 是第 3 个控制帧
    expect(sock.texts()[2]).toEqual({ type: 'close', data: { chan: 2 } })
    expect(channel.frame(new Uint8Array([1]))).toBe(false)
    sock.push(encodeFrame(2, new Uint8Array([1])))
    expect(rec.onData).not.toHaveBeenCalled()
  })

  it('通道未就绪时 request 直接失败，不发帧', async () => {
    const channel = hub.attach(makeSpec().spec)
    const assertion = expect(channel.request('ls', { path: '/' })).rejects.toThrow('通道尚未就绪')
    lastSocket().accept() // 握手成功但还没 open
    await assertion
    expect(lastSocket().texts()).toHaveLength(1) // 只有 open
  })
})

describe('createHub：控制面一问一答', () => {
  it('request 注入本通道 chan，并按 seq 了结', async () => {
    const { channel, sock } = await attachAndOpen(3)
    const p = channel.request<{ path: string }>('ls', { path: '/tmp' })
    expect(sock.texts()[1]).toEqual({ type: 'ls', seq: 2, data: { path: '/tmp', chan: 3 } })
    sock.reply({ type: 'ls', seq: 2, data: { path: '/tmp', files: [] } })
    await expect(p).resolves.toEqual({ path: '/tmp', files: [] })
  })

  it('error 响应让对应 request 以服务端消息 reject', async () => {
    const { channel, sock } = await attachAndOpen(3)
    const p = channel.request('rm', { path: '/nope' })
    sock.reply({ type: 'error', seq: sock.seqOf(1), data: { message: 'permission denied' } })
    await expect(p).rejects.toThrow('permission denied')
  })

  it('请求超时后 reject，迟到的响应不再误判', async () => {
    const { channel, sock } = await attachAndOpen(3)
    const p = channel.request('ls', { path: '/x' }, 1000)
    const assertion = expect(p).rejects.toThrow('ls 请求超时')
    vi.advanceTimersByTime(1000)
    await assertion
    // 迟到响应找不到等待者，静默丢弃（不得抛错、不得影响后续请求）
    sock.reply({ type: 'ls', seq: 2, data: { path: '/x' } })
    const p2 = channel.request('ls', { path: '/y' }, 1000)
    expect(sock.texts()[2].seq).toBe(3)
    sock.reply({ type: 'ls', seq: 3, data: { path: '/y' } })
    await expect(p2).resolves.toEqual({ path: '/y' })
  })

  it('notify 是不等回复的控制帧（不带 seq），resize 这类高频事据此发送', async () => {
    const { channel, sock } = await attachAndOpen(5)
    expect(channel.notify('resize', { cols: 120, rows: 40 })).toBe(true)
    expect(sock.texts()[1]).toEqual({ type: 'resize', data: { cols: 120, rows: 40, chan: 5 } })
  })

  it('seq=0 的主动推送按 data.chan 投递给所属通道', async () => {
    const { channel, sock, rec } = await attachAndOpen(6)
    sock.reply({ type: 'upload_end', data: { chan: 6, size: 10 } })
    expect(rec.onNotify).toHaveBeenCalledWith('upload_end', { chan: 6, size: 10 })
    expect(channel.state.value).toBe('open')
  })

  it('归属不明的控制帧只留日志，不能让整条连接崩掉', async () => {
    const { sock, rec } = await attachAndOpen(6)
    sock.reply({ type: 'upload_end', data: { chan: 99 } })
    sock.reply({ type: 'upload_end' })
    expect(rec.onNotify).not.toHaveBeenCalled()
    expect(sock.readyState).toBe(FakeSocket.OPEN)
  })

  it('pong 只用于续命，不分发给通道', async () => {
    const { sock, rec } = await attachAndOpen(6)
    sock.reply({ type: 'pong' })
    expect(rec.onNotify).not.toHaveBeenCalled()
  })
})

describe('createHub：数据面路由', () => {
  it('frame 用本通道 chan 编码，end 落成 FLAG_END', async () => {
    const { channel, sock } = await attachAndOpen(7)
    expect(channel.frame(new Uint8Array([1, 2]), false)).toBe(true)
    expect(channel.frame(new Uint8Array(0), true)).toBe(true)
    expect(sock.frames()).toEqual([
      { chan: 7, end: false, payload: new Uint8Array([1, 2]) },
      { chan: 7, end: true, payload: new Uint8Array(0) },
    ])
  })

  it('入站数据帧按 chan 投递，别的通道收不到', async () => {
    const a = makeSpec()
    const channelA = attach(a)
    lastSocket().reply({ type: 'open', seq: 1, data: { kind: 'sftp', chan: 1 } })
    await tick()

    const b = makeSpec()
    const channelB = hub.attach(b.spec)
    openReply(lastSocket(), 2)
    await tick()
    expect([channelA.state.value, channelB.state.value]).toEqual(['open', 'open'])

    lastSocket().push(encodeFrame(2, new Uint8Array([9, 9])))
    expect(a.onData).not.toHaveBeenCalled()
    expect(b.onData).toHaveBeenCalledWith(new Uint8Array([9, 9]), false)

    // 无主通道号（本连接上没这路通道）丢弃即可，不得抛错
    lastSocket().push(encodeFrame(42, new Uint8Array([1])))
    expect(b.onData).toHaveBeenCalledTimes(1)
  })

  it('不足帧头的二进制帧说明字节流已错位：主动断开重连，不拼出坏数据', async () => {
    const { channel, sock, rec } = await attachAndOpen(1)
    sock.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer })
    expect(sock.readyState).toBe(FakeSocket.CLOSED)
    expect(rec.onData).not.toHaveBeenCalled()
    expect(channel.state.value).toBe('opening')
    expect(hub.status.value).toBe('reconnecting')

    vi.advanceTimersByTime(1000)
    expect(FakeSocket.created).toHaveLength(2)
  })

  it('链路断开：在途请求作废、通道退回 opening，重连后自动重开并沿用新 chan', async () => {
    const { channel, sock, rec } = await attachAndOpen(3)
    const p = channel.request('ls', { path: '/x' })
    const assertion = expect(p).rejects.toThrow('连接已断开')

    sock.drop()
    await assertion
    expect(channel.state.value).toBe('opening')
    expect(hub.status.value).toBe('reconnecting')

    vi.advanceTimersByTime(1000) // 首次退避 1s
    const next = lastSocket()
    expect(next).not.toBe(sock)
    next.accept()
    expect(next.texts()[0].type).toBe('open')
    openReply(next, 9)
    await tick()
    expect(channel.state.value).toBe('open')
    expect(rec.onOpen).toHaveBeenCalledTimes(2)

    expect(channel.frame(new Uint8Array([5]))).toBe(true)
    expect(next.frames()[0].chan).toBe(9)
  })

  it('心跳：15s 发一个无 seq 的 ping；10s 内无入站帧即判死链', async () => {
    const { sock } = await attachAndOpen(1)
    vi.advanceTimersByTime(15_000)
    expect(sock.texts()[1]).toEqual({ type: 'ping' })

    vi.advanceTimersByTime(10_000)
    expect(sock.readyState).toBe(FakeSocket.CLOSED)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.created).toHaveLength(2)
  })

  it('心跳有来帧即续命：pong 到了就不误杀连接', async () => {
    const { sock } = await attachAndOpen(1)
    vi.advanceTimersByTime(15_000)
    sock.reply({ type: 'pong' })
    vi.advanceTimersByTime(10_000)
    expect(sock.readyState).toBe(FakeSocket.OPEN)
    expect(FakeSocket.created).toHaveLength(1)
  })

  it('后台标签页跳过客户端心跳：服务端 WS Ping 会由浏览器自动回 Pong 续命', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    const { sock } = await attachAndOpen(1)
    vi.advanceTimersByTime(60_000)
    expect(sock.texts().some((t) => t.type === 'ping')).toBe(false)
    expect(sock.readyState).toBe(FakeSocket.OPEN)
  })

  // 连上就断（拨号一直失败）：退避到上限后停手，不再无限冲击服务端
  it('反复断线到达上限后停止重连并置 failed', () => {
    hub.attach(makeSpec().spec)
    for (let i = 0; i < 14; i++) {
      lastSocket().drop()
      vi.advanceTimersByTime(20_000)
    }
    expect(hub.status.value).toBe('failed')
    const created = FakeSocket.created.length
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.created.length).toBe(created)
  })
})

describe('createHub：输入窗口（发送方向流控）', () => {
  it('waitAck 超窗时等 ack 推进，ack 到达即放行；ack 不转发给业务回调', async () => {
    const { channel, sock, rec } = await attachWithWindow(8)
    expect(channel.frame(new Uint8Array(5))).toBe(true)
    let drained = false
    const p = channel.waitAck(5)
    p.then(() => {
      drained = true
    })
    await tick()
    expect(drained).toBe(false) // 占用 5 + 要发 5 超出窗口 8，等 ack

    sock.reply({ type: 'ack', data: { chan: 1, bytes: 4 } })
    await expect(p).resolves.toBeUndefined()
    expect(rec.onNotify).not.toHaveBeenCalled() // ack 是枢纽自己的账，不打扰业务
  })

  it('窗口外的帧拒绝发出：客户端始终合规，服务端队列预算填不满', async () => {
    const { channel, sock } = await attachWithWindow(8)
    expect(channel.frame(new Uint8Array(8))).toBe(true)
    expect(channel.frame(new Uint8Array(1))).toBe(false) // 占用 8 + 1 > 8
    sock.reply({ type: 'ack', data: { chan: 1, bytes: 4 } })
    expect(channel.frame(new Uint8Array(1))).toBe(true) // 8 + 1 - 4 ≤ 8
    expect(sock.frames()).toHaveLength(2) // 被拒的帧没上过线
  })

  it('ack 只增不减：终止路径上乱序回退的 ack 不得缩小已确认字节', async () => {
    const { channel, sock } = await attachWithWindow(8)
    expect(channel.frame(new Uint8Array(5))).toBe(true)
    const p = channel.waitAck(5)
    sock.reply({ type: 'ack', data: { chan: 1, bytes: 4 } })
    await expect(p).resolves.toBeUndefined()
    sock.reply({ type: 'ack', data: { chan: 1, bytes: 2 } }) // 回退值：忽略
    // 5 + 6 - 4 ≤ 8 立即放行；若 acked 被拉回 2，这里会悬等
    await expect(channel.waitAck(6)).resolves.toBeUndefined()
  })

  it('通道出错时放行等待者，让上传循环立刻回去看错误状态', async () => {
    const { channel, sock } = await attachWithWindow(8)
    expect(channel.frame(new Uint8Array(8))).toBe(true)
    const p = channel.waitAck(1)
    sock.reply({ type: 'error', data: { chan: 1, message: '通道已中止' } })
    await expect(p).resolves.toBeUndefined()
  })

  it('链路断开时 waitAck 立即返回，让调用方在下一次 frame 上拿到 false', async () => {
    const { channel, sock } = await attachWithWindow(8)
    sock.drop()
    await expect(channel.waitAck(1)).resolves.toBeUndefined()
    expect(channel.frame(new Uint8Array(1))).toBe(false)
  })

  it('重连后窗口账本重置：缓冲的发送按新窗口放行', async () => {
    const { channel, sock } = await attachWithWindow(8)
    expect(channel.frame(new Uint8Array(8))).toBe(true)
    const p = channel.waitAck(1) // 等窗口，悬着
    sock.drop()
    await expect(p).resolves.toBeUndefined() // 断链先放行

    vi.advanceTimersByTime(1000)
    const next = lastSocket()
    next.accept()
    openReply(next, 9, { window: 8 })
    await tick()
    expect(channel.frame(new Uint8Array(8))).toBe(true) // 新账本 sent=0，可再发满窗
  })
})

describe('createHub：释放', () => {
  it('dispose 关掉连接与定时器，状态回 idle 且不再重连', async () => {
    const { sock } = await attachAndOpen(1)
    hub.dispose()
    expect(sock.readyState).toBe(FakeSocket.CLOSED)
    expect(hub.status.value).toBe('idle')
    const created = FakeSocket.created.length
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.created.length).toBe(created)
  })

  it('dispose 后 attach 不再建连', async () => {
    hub.dispose()
    const rec = makeSpec()
    hub.attach(rec.spec)
    expect(FakeSocket.created).toHaveLength(0)
  })
})

describe('uiStatus：链路态 + 通道态折叠为界面五态', () => {
  it('链路没连上时一律跟随链路', () => {
    expect(uiStatus('idle', 'open')).toBe('idle')
    expect(uiStatus('connecting', 'opening')).toBe('connecting')
    expect(uiStatus('reconnecting', 'open')).toBe('reconnecting')
    expect(uiStatus('failed', 'error')).toBe('failed')
  })

  it('WS 握手成功不等于 shell 就绪：通道未开绝不显示 connected', () => {
    expect(uiStatus('connected', 'opening')).toBe('connecting')
    expect(uiStatus('connected', 'error')).toBe('failed')
    expect(uiStatus('connected', 'open')).toBe('connected')
  })
})
