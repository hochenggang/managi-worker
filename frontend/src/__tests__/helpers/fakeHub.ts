// 假枢纽：只实现「通道接缝」这一层，供 composable 单测驱动与断言。
// 真实链路（握手、心跳、重连、帧路由）由 useWSHub.test.ts 用假 WebSocket 覆盖，
// 这里不重复验证，只让被测代码拿到一个可编排的对端。

import { ref, type Ref } from 'vue'
import type { Channel, ChannelSpec, ChannelState, ConnectionStatus, Hub } from '@/composables/useWSHub'
import type { Kind, OpenResponse, RequestData, Verb } from '@/protocol/ws'

export interface FakeRequest {
  type: Verb
  data: RequestData
  /** 服务端回成功响应 */
  ok: (data?: unknown) => void
  /** 服务端回 error */
  err: (message: string) => void
}

export interface FakeFrame {
  payload: Uint8Array
  end: boolean
}

export interface FakeChannel {
  readonly state: Ref<ChannelState>
  readonly spec: ChannelSpec
  readonly requests: FakeRequest[]
  readonly notifies: Array<{ type: Verb; data: RequestData }>
  readonly frames: FakeFrame[]
  readonly ackWaits: number
  readonly closeCalls: number
  /** 让此后的 waitAck 悬挂（模拟窗口耗尽），直到出错/断链/通道关闭/ready 时放行 */
  holdAcks: () => void
  /** 通道就绪：hub 重开成功，回调 onOpen 并放行后续帧 */
  ready: (resp?: Partial<OpenResponse> & { chan?: number; kind?: Kind }) => void
  /** 链路断开：chan 作废、state 退回 opening，真实重开由 ready() 模拟 */
  lost: () => void
  /** 通道打开失败 */
  fail: () => void
  /** 服务端推一帧数据 */
  push: (payload: Uint8Array, end?: boolean) => void
  /** 服务端主动推控制帧（seq=0） */
  emit: (type: Verb, data?: unknown) => void
  /** 最近一次请求；不存在则报错，避免断言静默落在 undefined 上 */
  lastRequest: (type?: Verb) => FakeRequest
}

export interface FakeHub extends Hub {
  readonly status: Ref<ConnectionStatus>
  readonly channels: FakeChannel[]
  /** 第 i 路 attach 出来的通道（默认最后一路） */
  channel(index?: number): FakeChannel
}

export function createFakeHub(link: ConnectionStatus = 'connected'): FakeHub {
  const status = ref<ConnectionStatus>(link)
  const channels: FakeChannel[] = []
  let chanSeq = 0

  const attach = (spec: ChannelSpec): Channel => {
    const state = ref<ChannelState>('opening')
    const requests: FakeRequest[] = []
    const notifies: Array<{ type: Verb; data: RequestData }> = []
    const frames: FakeFrame[] = []
    const counters = { ack: 0, close: 0 }
    let chan = 0
    // holdAcks 后的悬挂者。真实枢纽在出错/断链/摘除时无条件放行（waitAck 的注释），
    // 这里照搬同一套放行时机，让被测代码的"等窗口→复核"路径能被确定性驱动。
    const pendingAcks: Array<() => void> = []
    let holdingAcks = false
    const flushAcks = (): void => {
      for (const release of pendingAcks.splice(0)) release()
    }

    const fake: FakeChannel = {
      state,
      spec,
      requests,
      notifies,
      frames,
      get ackWaits() {
        return counters.ack
      },
      get closeCalls() {
        return counters.close
      },
      holdAcks: () => {
        holdingAcks = true
      },
      ready: (resp) => {
        chan = resp?.chan ?? ++chanSeq
        state.value = 'open'
        flushAcks() // 重开成功：与真实枢纽一致，等窗口的挂起者按新账本复核放行
        spec.onOpen({ ...resp, kind: resp?.kind ?? 'sftp', chan })
      },
      lost: () => {
        chan = 0
        // 链路断了，在途请求等不到回复：与真实枢纽一样立即失败，不留悬等
        for (const r of requests) r.err('连接已断开')
        flushAcks()
        if (state.value === 'open') state.value = 'opening'
      },
      fail: () => {
        chan = 0
        state.value = 'error'
        flushAcks()
      },
      push: (payload, end = false) => spec.onData(payload, end),
      emit: (type, data) => {
        spec.onNotify(type, data)
        // 与真实枢纽一致：通道级错误随后放行等窗口的挂起者
        if (type === 'error') flushAcks()
      },
      lastRequest: (type) => {
        const found = type ? [...requests].reverse().find((r) => r.type === type) : requests[requests.length - 1]
        if (!found) throw new Error(`未发出${type ? ` ${type} ` : ''}请求`)
        return found
      },
    }

    const channel: Channel = {
      state,
      request: <T>(type: Verb, data?: RequestData): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          if (!chan) {
            reject(new Error('通道尚未就绪'))
            return
          }
          const sent = { ...data, chan }
          requests.push({
            type,
            data: sent,
            ok: (v) => resolve(v as T),
            err: (m) => reject(new Error(m)),
          })
        }),
      notify: (type, data) => {
        if (!chan) return false
        notifies.push({ type, data: { ...data, chan } })
        return true
      },
      frame: (payload, end = false) => {
        if (!chan) return false
        frames.push({ payload, end })
        return true
      },
      waitAck: () => {
        counters.ack++
        if (!holdingAcks) return Promise.resolve()
        return new Promise<void>((resolve) => pendingAcks.push(resolve))
      },
      close: () => {
        counters.close++
        chan = 0
        // 与真实枢纽一致：摘除通道时了在途请求并放行等窗口者，不留悬等 Promise（已了结的是 no-op）
        for (const r of requests) r.err('通道已关闭')
        flushAcks()
      },
    }

    channels.push(fake)
    return channel
  }

  return {
    status,
    channels,
    attach,
    dispose: () => {},
    channel: (index = channels.length - 1) => {
      const c = channels[index]
      if (!c) throw new Error(`尚未 attach 第 ${index + 1} 路通道`)
      return c
    },
  }
}
