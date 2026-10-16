// useTerminal：一路终端标签 = 一个 xterm 实例 + 共享 /ws 上的一路 PTY 通道。
//
// 输出走数据面原始字节，直接 term.write(Uint8Array)：不经过 string→JSON，
// 既省转义与再解析，也不会把跨帧边界的半个 UTF-8 字符变成 U+FFFD。
// 断线时输入按帧缓冲，重连（同一 session_id，后端 shell 还在）后按序补发。
// 粘贴这类大块输入按发送缓冲水位逐帧发出，不等队列降下来不发下一片。

import { computed, onUnmounted, watch } from 'vue'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { uiStatus, useWSHub } from './useWSHub'
import { useConfirm } from './useConfirm'
import { splitBytes } from '@/protocol/frames'
import type { ErrorData, OpenPTY, OpenResponse } from '@/protocol/ws'
import { nodeSessionKey, type ApiNode } from '@/protocol/types'
import { handleError } from '@/helper'
import { useSettingsStore, waitForTerminalFont } from '@/stores/settingsStore'

// 会话 ID 缓存：按 nodeSessionKey（含凭据指纹）索引，同节点复用同一 sessionId。
// 前端断线重连时携带相同 sessionId，后端即可复用已维护的 shell 会话。
// 模块级 Map 永不清理会导致长期使用后内存泄漏。提供 clearSessionId 供节点删除场景调用。
const sessionIds = new Map<string, string>()
function getSessionId(node: ApiNode): string {
  const key = nodeSessionKey(node)
  let id = sessionIds.get(key)
  if (!id) {
    id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
    sessionIds.set(key, id)
  }
  return id
}

/** clearSessionId 清除指定节点的会话 ID 缓存。
 *  在节点被删除时调用，避免 sessionId 残留导致复用到已失效的后端会话。
 */
export function clearSessionId(node: ApiNode): void {
  sessionIds.delete(nodeSessionKey(node))
}

/** clearAllSessionIds 清空全部会话 ID 缓存。
 *  M1：在 clearNodes/setAllNodes（导入配置覆盖全部节点）时调用，
 *  避免旧节点的 sessionId 残留导致复用到已失效的后端会话。
 */
export function clearAllSessionIds(): void {
  sessionIds.clear()
}

// 回滚缓冲行数：默认 1000 行对运维场景偏小，5000 行在内存与体验间取衡。
const SCROLLBACK_LINES = 5000

// 擦屏并清回滚：重连复用同一后端会话时，服务端会整段回放 scrollback，
// 不先擦掉屏上内容就会看到同一批输出重演一遍。
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

// open 响应未到时的兜底分片大小。真值总由服务端下发（chunk_size），
// 这里只需保证「首帧之前」不会切出 1 字节一片。
const DEFAULT_INPUT_FRAME_BYTES = 32 * 1024

// 待发送输入的字节上限。粘贴在慢链路上排队，超出即拒绝本次输入并出声——
// 有界才不会让一次粘贴把标签页压死；丢弃必须可见，绝不静默吞字节。
const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024

// 粘贴超过这两项之一就先问一句：大块输入会挤在发送队列里，值得让用户确认一次；
// 日常几行命令低于阈值，不打扰。
const PASTE_CONFIRM_BYTES = 32 * 1024
const PASTE_CONFIRM_LINES = 20

// 远端 tty 按行截断（Linux MAX_CANON 约 4095 字节）：单行超出会有字节到不了 shell，
// 这是远端终端的固有属性，只能提醒用户，前端分帧救不了。
const MAX_CANON_BYTES = 4000

const encoder = new TextEncoder()

export function useTerminal(container: HTMLElement, node: ApiNode) {
  // 从设置 store 读取终端字体大小与字体族，并在变化时热更新
  const settings = useSettingsStore()
  const term = new Terminal({
    cursorBlink: true,
    scrollback: SCROLLBACK_LINES,
    fontSize: settings.settings.terminalFontSize,
    fontFamily: settings.settings.terminalFontFamily,
    rightClickSelectsWord: false,
    theme: getTerminalTheme(),
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  // URL 可点击（依赖已在 package.json，此前未接线）
  term.loadAddon(new WebLinksAddon())
  term.open(container)
  fitAddon.fit()
  term.focus()

  const hub = useWSHub()
  const { confirm } = useConfirm()
  const sessionId = getSessionId(node)
  // 待发送的输入帧：断线缓冲与粘贴背压共用一条队列，保证顺序只有一个来源。
  let outbound: Uint8Array[] = []
  let outboundBytes = 0
  let pumping = false
  // 单帧载荷上限：服务端定（超限的帧会被 WS 读上限掐断整条连接）。
  let frameBudget = DEFAULT_INPUT_FRAME_BYTES
  let openedOnce = false
  // 字体加载是异步的，落地时终端可能已经卸载，dispose 过的实例不能再 fit。
  let disposed = false

  const channel = hub.attach({
    openData: (): OpenPTY => ({
      kind: 'pty',
      node,
      session_id: sessionId,
      cols: term.cols,
      rows: term.rows,
    }),
    onOpen: (resp: OpenResponse) => {
      openedOnce = true
      if (resp.chunk_size) frameBudget = resp.chunk_size
      if (resp.reattached) {
        term.write(CLEAR_SCREEN)
        term.writeln('\x1b[32m[已恢复之前的会话]\x1b[0m')
      }
    },
    onData: (payload, end) => {
      if (payload.byteLength) term.write(payload)
      if (!end) return
      // 后端会话被回收（shell 退出或空闲超时）：必须出声，
      // 否则用户会对着一个不再回话的提示符一直敲下去。
      clearOutbound()
      term.writeln('\x1b[33m[会话已结束]\x1b[0m')
    },
    onNotify: (type, data) => {
      if (type !== 'error') return
      const message = (data as ErrorData | undefined)?.message ?? '未知错误'
      term.writeln(`\x1b[31m错误：${message}\x1b[0m`)
      // 从未打开成功（认证失败、目标不可达）时终端里那行红字容易被忽略，补一条通知
      if (!openedOnce) handleError(`终端连接失败：${message}`)
    },
  })

  /** sendInput 把用户输入切成数据帧发出。
   *  整段粘贴 xterm 只回调一次 onData，不分帧会把几十 MB 塞进一帧，
   *  服务端按超限掐断整条连接（表现为「粘贴长文本就断线」）。
   */
  function sendInput(data: string): void {
    const bytes = encoder.encode(data)
    if (!bytes.byteLength) return
    // 交互敲键走同步快路径：不进队列、不等微任务，手感与原生终端一致
    if (!outbound.length && bytes.byteLength <= frameBudget && channel.frame(bytes)) return
    if (outboundBytes + bytes.byteLength > MAX_OUTBOUND_BYTES) {
      term.writeln('\x1b[33m[输入缓冲已满，本次输入已丢弃，请分段粘贴]\x1b[0m')
      return
    }
    for (const part of splitBytes(bytes, frameBudget)) {
      outbound.push(part)
      outboundBytes += part.byteLength
    }
    void pumpOutbound()
  }
  term.onData(sendInput)

  /** pumpOutbound 逐帧发出缓冲：每片先等输入窗口腾出空间（服务端 ack 推进）再发送。
   *  一次性把整段粘贴塞进 ws.send() 会让发送队列无界增长，慢链路下标签页直接卡死；
   *  按窗口发送则每一片都在服务端可追踪的账内，其队列预算永远填不满。
   *  链路断开时 waitAck 立即放行、frame() 返回 false，整体留着等通道重开，既不重发也不丢。
   */
  async function pumpOutbound(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (outbound.length) {
        const head = outbound[0]
        await channel.waitAck(head.byteLength)
        // 等待期间缓冲可能已被清空（会话结束）或换过头：以醒来时的队列为准，
        // 别把已作废的字节塞回通道
        if (outbound[0] !== head) continue
        if (!channel.frame(head)) return
        outbound.shift()
        outboundBytes -= head.byteLength
      }
    } finally {
      pumping = false
    }
  }

  function clearOutbound(): void {
    outbound = []
    outboundBytes = 0
  }

  const stopStateWatch = watch(channel.state, (s) => {
    if (s === 'open') void pumpOutbound()
  })

  /** guardPaste 粘贴入口：超过阈值的先确认，再提示单行截断风险，最后交回 term.paste()。
   *  只交原文给 term.paste()：xterm 内部按当前 DEC mode 2004（bracketed paste）
   *  决定是否包裹 ESC[200~/ESC[201~。手写包裹会在未启用该模式的 shell/vim 里
   *  把转义序列当字面量显示，故禁止在此拼接转义序列。
   */
  async function guardPaste(text: string): Promise<void> {
    const bytes = encoder.encode(text).byteLength
    const lines = text.split(/[\r\n]/).length
    if (bytes > PASTE_CONFIRM_BYTES || lines > PASTE_CONFIRM_LINES) {
      const kb = Math.round(bytes / 1024)
      if (!(await confirm(`粘贴 ${lines} 行 / ${kb} KB 到终端？`))) {
        term.writeln('\x1b[33m[已取消粘贴]\x1b[0m')
        return
      }
    }
    if (maxLineBytes(text) > MAX_CANON_BYTES) {
      term.writeln('\x1b[33m[提示：单行超过约 4000 字节会被远端终端截断]\x1b[0m')
    }
    term.paste(text)
    term.focus()
  }

  // Ctrl+V 落在 xterm 的内部 textarea 上：在容器捕获阶段接管，才能在字节进入
  // 发送队列之前拦下来（等 onData 回调时已经发出去了）。
  const handlePaste = (ev: ClipboardEvent): void => {
    const text = ev.clipboardData?.getData('text') ?? ''
    if (!text) return // 让 xterm 自己处理（读不到文本时不该吞掉粘贴）
    ev.preventDefault()
    ev.stopPropagation()
    void guardPaste(text)
  }
  container.addEventListener('paste', handlePaste, true)

  // 右键菜单：有选区则复制，无选区则粘贴（屏蔽浏览器默认右键菜单）。
  // 非安全上下文（HTTP）下 navigator.clipboard 不可用，降级到 execCommand。
  const handleContextMenu = async (ev: MouseEvent) => {
    ev.preventDefault()
    const selection = term.getSelection()
    if (selection) {
      await copyToClipboard(selection)
      term.clearSelection()
      return
    }
    const text = await readFromClipboard()
    if (!text) return
    await guardPaste(text)
  }
  container.addEventListener('contextmenu', handleContextMenu)

  // 布局变化后把新行列数告知后端（openData 自带 cols/rows，所以重连无需补发）。
  const sendResize = (): void => {
    channel.notify('resize', { cols: term.cols, rows: term.rows })
  }
  const onResize = (): void => {
    fitAddon.fit()
    sendResize()
  }

  // 移除冗余的 window.addEventListener('resize')，
  // ResizeObserver 已覆盖容器尺寸变化（含 window resize 导致的变化）。
  const resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(container)

  // 内嵌字体是异步解码的，而 xterm 只在 fontFamily/fontSize 真的变化时才重新量字符宽高
  // （同值赋值是显式 no-op），所以刷新后首开可能一直按兜底字体排版。字体落地后把字号
  // 推一格再退回，逼它重测，然后按新宽高重新 fit 并把行列数同步给后端。
  function refitWhenFontsReady(): void {
    const { terminalFontFamily: family, terminalFontSize: size } = settings.settings
    void waitForTerminalFont(family, size).then(() => {
      if (disposed) return
      term.options.fontSize = size + 1
      term.options.fontSize = size
      onResize()
    })
  }
  refitWhenFontsReady()

  // 监听终端字体/主题变化，热更新 xterm 实例并重新 fit
  const stopSettingsWatch = watch(
    () => settings.settings,
    (s) => {
      term.options.fontSize = s.terminalFontSize
      term.options.fontFamily = s.terminalFontFamily
      // 主题变更时重新读取 CSS 变量（applyTheme 会切换 document 上的 class）
      term.options.theme = getTerminalTheme()
      // 字体/主题变化影响字符宽高，需重新 fit 同步行列数到后端
      fitAddon.fit()
      sendResize()
      // 新字体可能还没生效，fit 一次不算完，加载落地后再校正一次
      refitWhenFontsReady()
    },
    { deep: true },
  )

  // 界面状态 = 链路状态 + 通道状态：WS 握手成功不等于 shell 已就绪。
  const status = computed(() => uiStatus(hub.status.value, channel.state.value))

  onUnmounted(() => {
    disposed = true
    stopStateWatch()
    stopSettingsWatch()
    container.removeEventListener('contextmenu', handleContextMenu)
    container.removeEventListener('paste', handlePaste, true)
    resizeObserver.disconnect()
    channel.close()
    term.dispose()
    // tab 关闭时清除 sessionId 缓存：close 之后后端会话进入空闲回收，
    // 重新打开 tab 应当是新会话，而不是去 reattach 一个已失效的 shell。
    clearSessionId(node)
  })

  return { term, status }
}

/** maxLineBytes 返回最长一行的 UTF-8 字节数（tty 按行截断，不看总长）。
 *  一行最多 4 字节/字符，故按字符数上界先跳过不可能胜出的行，避免整段粘贴逐行编码。
 */
function maxLineBytes(text: string): number {
  let max = 0
  for (const line of text.split(/[\r\n]/)) {
    if (line.length * 4 <= max) continue
    max = Math.max(max, encoder.encode(line).byteLength)
  }
  return max
}

export function getTerminalTheme(): ITheme {
  const root = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string): string =>
    root.getPropertyValue(name).trim() || fallback

  return {
    background: get('--color-terminal-bg', '#2E3440'),
    foreground: get('--color-terminal-fg', '#D8DEE9'),
    cursor: get('--color-terminal-cursor', '#D8DEE9'),
    cursorAccent: get('--color-terminal-cursor-accent', '#2E3440'),
    selectionBackground: get('--color-terminal-selection', 'rgba(136, 192, 208, 0.3)'),
    black: get('--color-terminal-black', '#3B4252'),
    red: get('--color-terminal-red', '#BF616A'),
    green: get('--color-terminal-green', '#A3BE8C'),
    yellow: get('--color-terminal-yellow', '#EBCB8B'),
    blue: get('--color-terminal-blue', '#81A1C1'),
    magenta: get('--color-terminal-magenta', '#B48EAD'),
    cyan: get('--color-terminal-cyan', '#88C0D0'),
    white: get('--color-terminal-white', '#E5E9F0'),
    brightBlack: get('--color-terminal-brightBlack', '#4C566A'),
    brightRed: get('--color-terminal-brightRed', '#BF616A'),
    brightGreen: get('--color-terminal-brightGreen', '#A3BE8C'),
    brightYellow: get('--color-terminal-brightYellow', '#EBCB8B'),
    brightBlue: get('--color-terminal-brightBlue', '#81A1C1'),
    brightMagenta: get('--color-terminal-brightMagenta', '#B48EAD'),
    brightCyan: get('--color-terminal-brightCyan', '#8FBCBB'),
    brightWhite: get('--color-terminal-brightWhite', '#ECEFF4'),
  }
}

/** copyToClipboard 复制文本到剪贴板。
 *  修复 B14：非安全上下文（HTTP）下 navigator.clipboard 不可用，降级到 execCommand。
 */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  // 降级：用临时 textarea + execCommand('copy')
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}

/** readFromClipboard 从剪贴板读取文本。
 *  修复 B14：非安全上下文降级返回空字符串（execCommand 无 paste 等价物，
 *  浏览器安全策略禁止 JS 读取剪贴板，只能提示用户用 Ctrl+V）。
 */
async function readFromClipboard(): Promise<string> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }
  // 非安全上下文无法读取剪贴板，返回空（用户可用 Ctrl+V 粘贴）
  return ''
}
