import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import type { ApiNode } from '@/protocol/types'
import type { FakeChannel, FakeHub } from '../helpers/fakeHub'
import { createFakeHub } from '../helpers/fakeHub'

// vi.hoisted 确保 mock 在 vi.mock 工厂执行前已初始化
const { mockHandleError, mockConfirm, mockSettingsHolder, hubRef } = vi.hoisted(() => ({
  mockHandleError: vi.fn(),
  mockConfirm: vi.fn().mockResolvedValue(true),
  mockSettingsHolder: { settings: null as any },
  hubRef: { hub: null as any },
}))

vi.mock('@/helper', async (importActual) => ({
  ...(await importActual<typeof import('@/helper')>()),
  handleError: mockHandleError,
}))

// 确认框是全局单例对话框，单测里只关心「用户点了什么」
vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => mockSettingsHolder,
  // 测试环境没有真实字体，直接兑现：等字体的重测路径照走，断言才覆盖得到
  waitForTerminalFont: () => Promise.resolve(),
}))

// 只替换 useWSHub() 这个取单例的入口，uiStatus 等纯函数保持真实实现
vi.mock('@/composables/useWSHub', async (importActual) => ({
  ...(await importActual<typeof import('@/composables/useWSHub')>()),
  useWSHub: () => hubRef.hub,
}))

let onDataCb: ((data: string) => void) | null = null
let terminalCtorOpts: any = null
const mockTerminal = {
  options: {} as Record<string, unknown>,
  loadAddon: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  writeln: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    onDataCb = cb
    return { dispose: vi.fn() }
  }),
  dispose: vi.fn(),
  focus: vi.fn(),
  paste: vi.fn(),
  getSelection: vi.fn(() => ''),
  clearSelection: vi.fn(),
  cols: 100,
  rows: 30,
}

// 注意：构造函数必须用普通 function（箭头函数不能 new），且返回对象时 new 会用该返回值。
vi.mock('@xterm/xterm', () => ({
  Terminal: function MockTerminal(opts: any) {
    terminalCtorOpts = opts
    return mockTerminal
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function MockFitAddon() {
    return { fit: vi.fn() }
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function MockWebLinksAddon() {
    return { activate: vi.fn() }
  },
}))

import { clearSessionId, useTerminal } from '@/composables/useTerminal'

function makeSettings(overrides: Partial<{ terminalFontSize: number; terminalFontFamily: string }> = {}) {
  return reactive({
    theme: 'nord' as const,
    language: 'zh' as const,
    terminalFontSize: 14,
    terminalFontFamily: "'JetBrains Mono', monospace",
    ...overrides,
  })
}

mockSettingsHolder.settings = makeSettings()

const node: ApiNode = {
  name: 'n1',
  host: '1.2.3.4',
  port: 22,
  username: 'root',
  auth_type: 'password',
  auth_value: 'pwd',
}

// happy-dom 不提供 navigator.clipboard / isSecureContext，测试内按需打桩
function stubClipboard(text: string, secure: boolean): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: vi.fn().mockResolvedValue(text),
      writeText: vi.fn().mockResolvedValue(undefined),
    },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
}

let fake!: FakeHub

/** firePaste 派发一个带 clipboardData 的 paste 事件。
 *  happy-dom 的 ClipboardEvent/DataTransfer 构造器不可用，只能手工挂视图。
 */
function firePaste(el: HTMLElement, text: string | undefined): Event {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: text === undefined ? null : { getData: () => text },
  })
  el.dispatchEvent(ev)
  return ev
}

function withSetup<T>(composable: () => T): { result: T; unmount: () => void } {
  let result!: T
  const App = defineComponent({
    setup() {
      result = composable()
      return () => h('div')
    },
  })
  const wrapper = mount(App)
  return { result, unmount: () => wrapper.unmount() }
}

/** 挂载终端并把 PTY 通道置为就绪（chunk_size 由服务端下发）。 */
function mountTerminal(chunkSize = 4) {
  const container = document.createElement('div')
  const setup = withSetup(() => useTerminal(container, node))
  const chan = fake.channel()
  chan.ready({ kind: 'pty', chunk_size: chunkSize })
  return { ...setup, container, chan }
}

/** 把分出去的帧按顺序拼回原文：分片既不能丢也不能重。 */
function joinParts(parts: Uint8Array[]): string {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) {
    all.set(p, offset)
    offset += p.byteLength
  }
  return new TextDecoder().decode(all)
}

const sizes = (chan: { frames: Array<{ payload: Uint8Array }> }) =>
  chan.frames.map((f) => f.payload.byteLength)

/** 这路通道 open 负载里的会话 ID。 */
function sessionIdOf(chan: FakeChannel): string {
  const payload = chan.spec.openData()
  if (payload.kind !== 'pty') throw new Error('终端通道应当是 PTY')
  return payload.session_id
}

/** 等缓冲的帧全部发出：输入背压是逐帧 await 发送缓冲水位的，断言要等它跑完。 */
async function settled(chan: FakeChannel, count: number): Promise<void> {
  await vi.waitFor(() => expect(chan.frames).toHaveLength(count))
}

describe('useTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfirm.mockResolvedValue(true)
    onDataCb = null
    terminalCtorOpts = null
    mockSettingsHolder.settings = makeSettings()
    fake = createFakeHub()
    hubRef.hub = fake
  })

  it('mount: 建 xterm、挂插件、聚焦，并向枢纽 attach 一路 PTY 通道', () => {
    const container = document.createElement('div')
    withSetup(() => useTerminal(container, node))
    expect(mockTerminal.open).toHaveBeenCalledWith(container)
    expect(mockTerminal.loadAddon).toHaveBeenCalledTimes(2)
    expect(mockTerminal.focus).toHaveBeenCalledTimes(1)
    expect(fake.channel().spec.openData()).toMatchObject({
      kind: 'pty',
      node,
      cols: 100,
      rows: 30,
      session_id: expect.any(String),
    })
  })

  it('mount: 回滚行数大于 xterm 默认 1000', () => {
    withSetup(() => useTerminal(document.createElement('div'), node))
    expect(terminalCtorOpts.scrollback).toBeGreaterThan(1000)
  })

  // 同节点复用同一 sessionId（后端据此接续仍在保留的 shell）；tab 关闭后应起新会话
  it('sessionId: 同节点复用，unmount 后清除', () => {
    const a = withSetup(() => useTerminal(document.createElement('div'), node))
    const first = sessionIdOf(fake.channel(0))
    const b = withSetup(() => useTerminal(document.createElement('div'), node))
    expect(sessionIdOf(fake.channel(1))).toBe(first)
    a.unmount()
    const c = withSetup(() => useTerminal(document.createElement('div'), node))
    expect(sessionIdOf(fake.channel(2))).not.toBe(first)
    b.unmount()
    c.unmount()
  })

  // 输出走数据面原始字节：直接交给 term.write，不再经 JSON 与 string 往返
  it('onData: 原始字节直写 xterm，未结束不出提示', () => {
    const { chan } = mountTerminal()
    mockTerminal.write.mockClear()
    chan.push(new Uint8Array([0x1b, 0x5b, 0x31]))
    expect(mockTerminal.write).toHaveBeenCalledWith(new Uint8Array([0x1b, 0x5b, 0x31]))
    expect(mockTerminal.writeln).not.toHaveBeenCalled()
  })

  it('onData: 跨帧的半个 UTF-8 字符原样透传，不会被解码成 U+FFFD', () => {
    const { chan } = mountTerminal()
    mockTerminal.write.mockClear()
    const bytes = new TextEncoder().encode('好')
    chan.push(bytes.subarray(0, 2))
    chan.push(bytes.subarray(2))
    expect([...(mockTerminal.write.mock.calls[0][0] as Uint8Array)]).toEqual([...bytes.subarray(0, 2)])
    expect([...(mockTerminal.write.mock.calls[1][0] as Uint8Array)]).toEqual([...bytes.subarray(2)])
  })

  it('onData end: 会话结束后不再补发断线期间缓冲的输入', async () => {
    const { chan } = mountTerminal()
    chan.lost()
    onDataCb!('stale input')
    expect(chan.frames).toHaveLength(0)

    // 重开成功但 watcher 还没 flush，后端第一时间宣告这路会话已结束
    chan.ready({ kind: 'pty', chan: 9 })
    chan.push(new Uint8Array(0), true)
    await nextTick()
    expect(chan.frames).toHaveLength(0)
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('[会话已结束]'))
  })

  it('onOpen reattached: 先擦屏再提示恢复，避免回放内容重演一遍', () => {
    withSetup(() => useTerminal(document.createElement('div'), node))
    mockTerminal.write.mockClear()
    fake.channel().ready({ kind: 'pty', reattached: true })
    expect(mockTerminal.write).toHaveBeenCalledWith(expect.stringContaining('\x1b[3J'))
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('已恢复之前的会话'))
  })

  // 认证失败/目标不可达：终端里那行红字容易被忽略，首次打开失败额外弹通知
  it('onNotify error: 未打开成功时红字 + 通知，已打开后只写终端', () => {
    withSetup(() => useTerminal(document.createElement('div'), node))
    const chan = fake.channel()
    chan.emit('error', { message: 'ssh: rejected' })
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('错误：ssh: rejected'))
    expect(mockHandleError).toHaveBeenCalledWith('终端连接失败：ssh: rejected')

    mockTerminal.writeln.mockClear()
    mockHandleError.mockClear()
    chan.ready({ kind: 'pty' })
    chan.emit('error', { message: 'boom' })
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('错误：boom'))
    expect(mockHandleError).not.toHaveBeenCalled()
  })

  it('Terminal 构造使用设置里的字号与字体族', () => {
    mockSettingsHolder.settings = makeSettings({
      terminalFontSize: 18,
      terminalFontFamily: "'Fira Code', monospace",
    })
    withSetup(() => useTerminal(document.createElement('div'), node))
    expect(terminalCtorOpts.fontSize).toBe(18)
    expect(terminalCtorOpts.fontFamily).toBe("'Fira Code', monospace")
  })

  // 设置变化热更新 xterm，并把新的行列数告知后端（否则换行仍按旧尺寸算）
  it('设置变化：更新 options 并发送 resize', async () => {
    const { chan } = mountTerminal()
    mockSettingsHolder.settings.terminalFontSize = 20
    await nextTick()
    expect(mockTerminal.options.fontSize).toBe(20)
    expect(chan.notifies[chan.notifies.length - 1]).toEqual({
      type: 'resize',
      data: { cols: 100, rows: 30, chan: 1 },
    })
  })

  // 刷新后首开时内嵌字体还没解码，xterm 量到的是兜底字体的字符宽高；
  // 同值赋值不会触发它重测（OptionsService 显式跳过未变化的选项），
  // 所以字体落地必须走「字号推一格再退回」把测量逼出来，再按新宽高发 resize。
  it('字体落地后重测字符宽高并按新宽高发 resize', async () => {
    const writes: unknown[] = []
    Object.defineProperty(mockTerminal.options, 'fontSize', {
      configurable: true,
      get: () => 14,
      set: (value: unknown) => { writes.push(value) },
    })
    try {
      const { chan } = mountTerminal()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(writes).toEqual([15, 14])
      expect(chan.notifies[chan.notifies.length - 1]).toMatchObject({ type: 'resize' })
    } finally {
      delete mockTerminal.options.fontSize
    }
  })

  // 敲键是同步快路径：不进队列、不等 ack，手感不能被背压拖慢
  it('输入：单帧且链路就绪时同步发出，不经队列', () => {
    const { chan } = mountTerminal(1024)
    onDataCb!('ls\r')
    expect(sizes(chan)).toEqual([3])
    expect(chan.ackWaits).toBe(0)
  })

  it('输入按服务端下发的 chunk_size 分帧，逐帧等输入窗口放行后才发下一片', async () => {
    const { chan } = mountTerminal(4)
    onDataCb!('abcdefghij')
    await settled(chan, 3)
    expect(sizes(chan)).toEqual([4, 4, 2])
    expect(chan.frames.every((f) => !f.end)).toBe(true)
    expect(chan.ackWaits).toBe(3)
    expect(joinParts(chan.frames.map((f) => f.payload))).toBe('abcdefghij')
  })

  // 整段粘贴 xterm 只回调一次 onData：不分帧会把几十 MB 塞进一帧，
  // 服务端按超限即以 1009 掐断整条连接（表现为「粘贴长文本就断线」）。
  it('open 未给出 chunk_size 时用兜底尺寸分帧，不留 1 字节一片', async () => {
    const { unmount } = withSetup(() => useTerminal(document.createElement('div'), node))
    const chan = fake.channel()
    onDataCb!('x'.repeat(40 * 1024))
    expect(chan.frames).toHaveLength(0) // 通道未就绪，先缓冲
    chan.ready({ kind: 'pty' })
    await settled(chan, 2)
    expect(sizes(chan)).toEqual([32 * 1024, 8 * 1024])
    unmount()
  })

  // 断线期间缓冲，重连后每片只补发一次：既不丢也不重
  it('断线缓冲输入，通道重开后按序补发一次', async () => {
    const { chan } = mountTerminal(4)
    chan.lost()
    onDataCb!('abcdef')
    expect(chan.frames).toHaveLength(0)

    chan.ready({ kind: 'pty', chan: 2 })
    await settled(chan, 2)
    expect(sizes(chan)).toEqual([4, 2])
    expect(joinParts(chan.frames.map((f) => f.payload))).toBe('abcdef')
  })

  // 有界队列：超出上限就拒绝并出声，绝不静默吞字节，也绝不让队列无界增长
  it('缓冲超过上限时拒绝本次输入并在终端出声', () => {
    const { chan } = mountTerminal(1024)
    chan.lost()
    onDataCb!('x'.repeat(4 * 1024 * 1024))
    mockTerminal.writeln.mockClear()
    onDataCb!('overflow')
    expect(chan.frames).toHaveLength(0)
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('输入缓冲已满'))
  })

  it('右键粘贴：原文交给 term.paste，不手写 bracketed paste 转义', async () => {
    const { container } = mountTerminal()
    mockTerminal.paste.mockClear()
    stubClipboard('line1\nline2', true)
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(mockTerminal.paste).toHaveBeenCalledTimes(1))
    expect(mockTerminal.paste).toHaveBeenCalledWith('line1\nline2')
    expect(mockTerminal.paste.mock.calls[0][0]).not.toContain('200~')
  })

  it('右键粘贴：HTTP 非安全上下文读不到剪贴板则不产生任何输入', async () => {
    const { container } = mountTerminal()
    mockTerminal.paste.mockClear()
    stubClipboard('should-not-be-read', false)
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockTerminal.paste).not.toHaveBeenCalled()
  })

  it('粘贴：Ctrl+V 在容器捕获阶段接管，xterm 的 textarea 吃不到原文', async () => {
    const { container } = mountTerminal()
    const inner = document.createElement('textarea')
    container.appendChild(inner)
    const seenByXterm = vi.fn()
    inner.addEventListener('paste', seenByXterm)
    mockTerminal.paste.mockClear()

    const ev = firePaste(inner, 'clip text')
    await vi.waitFor(() => expect(mockTerminal.paste).toHaveBeenCalledWith('clip text'))
    expect(ev.defaultPrevented).toBe(true)
    expect(seenByXterm).not.toHaveBeenCalled()
  })

  // 大块粘贴会挤满发送队列，值得让用户确认一次；日常几行命令不打扰
  it('粘贴护栏：超过阈值先确认，用户拒绝则一个字都不发', async () => {
    const { container } = mountTerminal()
    mockTerminal.paste.mockClear()
    mockConfirm.mockResolvedValueOnce(false)
    firePaste(container, 'y'.repeat(40 * 1024))
    await vi.waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1))
    expect(mockConfirm).toHaveBeenCalledWith(expect.stringContaining('KB'))
    expect(mockTerminal.paste).not.toHaveBeenCalled()
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('[已取消粘贴]'))
  })

  it('粘贴护栏：确认后照常粘贴，并对超长单行提示远端截断', async () => {
    const { container } = mountTerminal()
    mockTerminal.paste.mockClear()
    mockTerminal.writeln.mockClear()
    firePaste(container, `${'z'.repeat(5000)}\nls`)
    await vi.waitFor(() => expect(mockTerminal.paste).toHaveBeenCalledTimes(1))
    expect(mockConfirm).not.toHaveBeenCalled() // 2 行 / 5KB：够不着确认阈值
    expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('会被远端终端截断'))
  })

  it('粘贴护栏：读不到 clipboardData 时不拦截，交回 xterm 自己处理', () => {
    const { container } = mountTerminal()
    mockTerminal.paste.mockClear()
    const ev = firePaste(container, undefined)
    expect(ev.defaultPrevented).toBe(false)
    expect(mockTerminal.paste).not.toHaveBeenCalled()
  })

  it('有选区时右键是复制而非粘贴', async () => {
    const { container } = mountTerminal()
    mockTerminal.getSelection.mockReturnValueOnce('selected text')
    mockTerminal.paste.mockClear()
    stubClipboard('clip', true)
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(mockTerminal.clearSelection).toHaveBeenCalledTimes(1))
    expect(mockTerminal.paste).not.toHaveBeenCalled()
  })

  it('不注册 window resize 监听（ResizeObserver 已覆盖）', () => {
    const spy = vi.spyOn(window, 'addEventListener')
    withSetup(() => useTerminal(document.createElement('div'), node))
    expect(spy.mock.calls.filter(([e]) => e === 'resize')).toHaveLength(0)
    spy.mockRestore()
  })

  // 界面态 = 链路态 + 通道态：WS 握手成功不等于 shell 已就绪
  it('status: 通道未开不显示 connected，通道失败显示 failed，链路重连优先', () => {
    const { result } = withSetup(() => useTerminal(document.createElement('div'), node))
    const chan = fake.channel()
    expect(result.status.value).toBe('connecting')
    chan.ready({ kind: 'pty' })
    expect(result.status.value).toBe('connected')
    chan.fail()
    expect(result.status.value).toBe('failed')
    fake.status.value = 'reconnecting'
    expect(result.status.value).toBe('reconnecting')
  })

  it('unmount: 摘除通道、销毁 xterm 并清除 sessionId', () => {
    clearSessionId(node)
    const { chan, unmount } = mountTerminal()
    expect(chan.closeCalls).toBe(0)
    expect(mockTerminal.dispose).not.toHaveBeenCalled()
    unmount()
    expect(chan.closeCalls).toBe(1)
    expect(mockTerminal.dispose).toHaveBeenCalledTimes(1)
    const again = withSetup(() => useTerminal(document.createElement('div'), node))
    expect(sessionIdOf(fake.channel(1))).not.toBe(sessionIdOf(chan))
    again.unmount()
  })
})
