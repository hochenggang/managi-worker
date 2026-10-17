// useBatchExec：把「一条命令发到 N 台机器」跑在 exec 通道上。
//
// 与旧 HTTP 批量接口的根本差别：
//   - 输出是流式的：命令边跑边显示，长命令不再「转圈等到超时才知道结果」；
//   - 每台机器一条 exec 通道，通道一关远端进程就跟着收掉，「停止」是真的停；
//   - 退出码与「通道出错」分开记：非零退出是结果，连接坏了才是错误（见 protocol/ws.ts exit）。
//
// 并发按服务端的通道上限收着开：一次性给 50 台机器各开一条通道，
// 服务端会把超限的那批直接拒掉，而用户看到的只是「有几个节点莫名失败」。

import { ref, type Ref } from 'vue'
import { useWSHub, type Channel, type Hub } from './useWSHub'
import type { ApiNode } from '@/protocol/types'
import type { ExitData, OpenExec } from '@/protocol/ws'
import { toErrorMessage } from '@/helper'

/** 一台机器上的执行状态。
 *  queued：选中了但还没轮到（并发没到上限）；running：通道已开、命令在跑。 */
export type ExecState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ExecRow {
  /** host:port:username，列表渲染的 key。 */
  id: string
  node: ApiNode
  state: ExecState
  stdout: string
  stderr: string
  /** 退出码。null = 服务端没拿到 exit-status（被掐断或对端未回传），不等于 0。 */
  code: number | null
  /** 服务端在 4MB 处截断了 stdout / stderr：显示的内容不完整，界面必须说出来。 */
  truncatedStdout: boolean
  truncatedStderr: boolean
  /** 通道级错误（连不上、服务器拒绝 exec、命令超长）。与「非零退出」是两件事。 */
  error: string
  /** 前端为了不卡死浏览器而停掉了追加（服务端那边其实还有数据）。 */
  trimmed: boolean
  elapsedMs: number
}

export interface BatchExec {
  rows: Ref<ExecRow[]>
  running: Ref<boolean>
  /** 本次实际使用的并发数（受服务端通道上限约束），供界面提示。 */
  concurrency: Ref<number>
  run: (nodes: ApiNode[], command: string) => Promise<void>
  /** 停掉还在跑的，清空排队的。已经跑完的保留结果。 */
  cancel: () => void
  /** 清空结果列表（不影响正在跑的任务）。 */
  clear: () => void
}

/** 同时在跑的机器数上限。取 6 是个折中：再多也只是把结果更早地堆到屏幕上，
 *  而这些通道与终端、文件管理共用同一个 MaxChannels 额度。 */
const PREFERRED_PARALLEL = 6

/** 单条流的展示上限。服务端已经在 4MB 截断，但 4MB 文本塞进 DOM 会把页面拖死；
 *  这里再收一道，并且明确告诉用户「显示被截断了」——静默截断等于撒谎。 */
const MAX_DISPLAY_CHARS = 256 * 1024

export function rowIdOf(node: ApiNode): string {
  return `${node.host}:${node.port}:${node.username}`
}

function emptyRow(node: ApiNode): ExecRow {
  return {
    id: rowIdOf(node),
    node,
    state: 'queued',
    stdout: '',
    stderr: '',
    code: null,
    truncatedStdout: false,
    truncatedStderr: false,
    error: '',
    trimmed: false,
    elapsedMs: 0,
  }
}

export function useBatchExec(hub: Hub = useWSHub()): BatchExec {
  const rows = ref<ExecRow[]>([])
  const running = ref(false)
  const concurrency = ref(1)
  /** 在途任务：cancel 时要逐个收尾并关通道，否则远端进程会一直跑到自己结束。 */
  const active = new Map<ExecRow, { channel: Channel; settle: (s: ExecState) => void }>()
  /** 轮次号。cancel 与新一轮 run 都会 +1：上一轮的 worker 靠它立刻收手，
   *  不然旧循环会把新一轮的 rows 当成自己的活儿接着跑。 */
  let generation = 0

  function cancel(): void {
    generation++
    running.value = false
    // 先收在跑的：关通道 → 远端进程被收掉，同时把这一行的状态落定
    for (const [, task] of [...active]) task.settle('cancelled')
    active.clear()
    // 排队中的没被开过通道，直接标成已取消，别让用户对着「排队中」干等
    for (const row of rows.value) {
      if (row.state === 'queued') row.state = 'cancelled'
    }
  }

  function clear(): void {
    rows.value = []
  }

  /** append 追加一段输出。超额只停追加、不丢已有内容，并把 trimmed 立起来。 */
  function append(row: ExecRow, toStderr: boolean, text: string): void {
    if (!text) return
    const key = toStderr ? 'stderr' : 'stdout'
    const current = row[key]
    if (current.length >= MAX_DISPLAY_CHARS) {
      row.trimmed = true
      return
    }
    const room = MAX_DISPLAY_CHARS - current.length
    if (text.length > room) {
      row[key] = current + text.slice(0, room)
      row.trimmed = true
      return
    }
    row[key] = current + text
  }

  /** execOne 在一台机器上跑一次命令，直到通道结束或出错。 */
  function execOne(row: ExecRow, command: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const startedAt = Date.now()
      // stdout 与 stderr 是两个独立的字节流，各自可能把多字节字符劈在两帧之间，
      // 必须各持一个流式解码器；共用一个会把两路的半个字符拼成乱码。
      const outDecoder = new TextDecoder()
      const errDecoder = new TextDecoder()
      let settled = false
      let channel: Channel | null = null

      const finish = (state: ExecState): void => {
        if (settled) return
        settled = true
        row.state = state
        row.elapsedMs = Date.now() - startedAt
        active.delete(row)
        if (channel) {
          // 关通道：服务端随之收掉远端进程。已经自然结束的通道关一次也无副作用。
          channel.close()
        }
        resolve()
      }

      /** 收尾状态。退出码 0 才算成功；null（未知）与非零都不算——
       *  把「没拿到退出码」显示成成功，会让人以为命令跑对了。 */
      const settleByCode = (): void => {
        finish(row.code === 0 ? 'done' : 'failed')
      }

      const ch = hub.attach({
        openData: (): OpenExec => ({ kind: 'exec', node: row.node, command }),
        onOpen: () => {
          row.state = 'running'
        },
        onData: (payload, end, stderr) => {
          if (payload.byteLength) {
            const decoder = stderr ? errDecoder : outDecoder
            // end 时收尾 flush，避免最后半个多字节字符留在解码器里
            append(row, stderr, decoder.decode(payload, { stream: !end }))
          }
          // FlagEnd 是这路流结束的权威信号：exit 帧可能先到，但输出还没排完
          if (end) settleByCode()
        },
        onNotify: (type, data) => {
          if (type === 'exit') {
            const d = data as ExitData
            row.code = d.code
            row.truncatedStdout = !!d.truncated_stdout
            row.truncatedStderr = !!d.truncated_stderr
            return
          }
          if (type === 'error') {
            // 通道级错误（认证失败、服务器拒绝 exec、命令超长）：如实记下并收尾
            row.error = (data as { message?: string } | undefined)?.message ?? '未知错误'
            finish('failed')
          }
        },
      })

      // attach 先返回、回调随后（都是异步投递），所以登记时 channel 一定已就位
      channel = ch
      active.set(row, { channel: ch, settle: finish })
    })
  }

  async function run(nodes: ApiNode[], command: string): Promise<void> {
    if (!nodes.length) return
    // 上一轮还没跑完就先停：两轮混在一起，用户分不清哪行输出属于哪次点击
    cancel()
    const gen = generation
    rows.value = nodes.map(emptyRow)
    running.value = true

    // 留一个通道给终端/文件管理，别把整条连接的额度吃干净
    const serverMax = hub.hello.value?.limits.max_channels ?? PREFERRED_PARALLEL + 1
    const limit = Math.max(1, Math.min(PREFERRED_PARALLEL, serverMax - 1, nodes.length))
    concurrency.value = limit

    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        // 轮次变了说明新一轮已经开始，这一轮的 worker 必须立刻撒手
        if (gen !== generation) return
        const index = cursor++
        const row = rows.value[index]
        if (!row) return
        row.state = 'running'
        try {
          await execOne(row, command)
        } catch (e) {
          row.error = toErrorMessage(e)
          row.state = 'failed'
        }
      }
    }
    await Promise.all(Array.from({ length: limit }, worker))
    if (gen === generation) running.value = false
  }

  return { rows, running, concurrency, run, cancel, clear }
}
