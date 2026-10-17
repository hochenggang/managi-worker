import { describe, expect, it } from 'vitest'
import { ref, type Ref } from 'vue'

import { useBatchExec } from '@/composables/useBatchExec'
import type { Channel, ChannelSpec, Hub } from '@/composables/useWSHub'
import type { ChannelState } from '@/composables/useWSHub'
import type { HelloData } from '@/protocol/ws'
import type { ApiNode } from '@/protocol/types'

const encoder = new TextEncoder()

function node(host: string): ApiNode {
  return { name: host, host, port: 22, username: 'root', auth_type: 'password', auth_value: 'x' }
}

function hello(maxChannels = 16): HelloData {
  return {
    protocol: 2,
    backend: 'test',
    limits: {
      max_channels: maxChannels,
      max_file_bytes: 10 << 20,
      max_list_entries: 10_000,
      max_remove_depth: 64,
      max_exec_output: 4 << 20,
      pty_idle_ttl_ms: 60_000,
    },
  }
}

interface FakeHub {
  hub: Hub
  specs: ChannelSpec[]
  closed: number[]
  /** 手动触发「服务端发出 end 帧」这类回调。 */
  emitData: (index: number, text: string, end: boolean, stderr?: boolean) => void
  emitExit: (index: number, code: number | null, extra?: Record<string, unknown>) => void
  emitError: (index: number, message: string) => void
  emitOpen: (index: number) => void
}

/** makeHub 造一个假枢纽：attach 只把 spec 记下来，什么时候开好、什么时候来字节，全由测试决定。 */
function makeHub(maxChannels = 16): FakeHub {
  const specs: ChannelSpec[] = []
  const closed: number[] = []
  let counter = 0

  const hub: Hub = {
    status: ref('connected'),
    hello: ref(hello(maxChannels)) as Ref<HelloData | null>,
    attach(spec: ChannelSpec): Channel {
      specs.push(spec)
      const id = ++counter
      const state = ref<ChannelState>('open')
      return {
        state,
        request: <T,>() => Promise.resolve({} as T),
        notify: () => true,
        frame: () => true,
        waitAck: () => Promise.resolve(),
        close: () => {
          if (!closed.includes(id)) closed.push(id)
        },
      }
    },
    dispose: () => {},
  }

  return {
    hub,
    specs,
    closed,
    emitOpen: (i) => specs[i].onOpen({ kind: 'exec', chan: i + 1 }),
    emitData: (i, text, end, stderr = false) =>
      specs[i].onData(encoder.encode(text), end, stderr),
    emitExit: (i, code, extra = {}) =>
      specs[i].onNotify('exit', { chan: i + 1, code, ...extra }),
    emitError: (i, message) => specs[i].onNotify('error', { chan: i + 1, message }),
  }
}

/** flush 让 run() 里的 await 链推进到「通道已开」这一步。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useBatchExec：一台机器一路 exec 通道', () => {
  it('正常跑完：stdout 累积、退出码 0、状态 done、通道被关', async () => {
    const fake = makeHub()
    const batch = useBatchExec(fake.hub)

    const done = batch.run([node('a')], 'echo hi')
    await flush()
    expect(fake.specs).toHaveLength(1)
    expect(fake.specs[0].openData()).toEqual({
      kind: 'exec',
      node: node('a'),
      command: 'echo hi',
    })

    fake.emitOpen(0)
    expect(batch.rows.value[0].state).toBe('running')
    fake.emitData(0, 'hi\n', false)
    fake.emitExit(0, 0)
    fake.emitData(0, '', true)
    await done

    const row = batch.rows.value[0]
    expect(row.stdout).toBe('hi\n')
    expect(row.code).toBe(0)
    expect(row.state).toBe('done')
    expect(fake.closed).toHaveLength(1)
    expect(batch.running.value).toBe(false)
  })

  it('stderr 与 stdout 分开累积，不混成一段', async () => {
    const fake = makeHub()
    const batch = useBatchExec(fake.hub)

    const done = batch.run([node('a')], 'false')
    await flush()
    fake.emitData(0, 'out\n', false)
    fake.emitData(0, 'boom\n', false, true)
    fake.emitExit(0, 1)
    fake.emitData(0, '', true)
    await done

    const row = batch.rows.value[0]
    expect(row.stdout).toBe('out\n')
    expect(row.stderr).toBe('boom\n')
    expect(row.code).toBe(1)
    // 非零退出是「结果」，不是「错误」：error 必须留空，否则界面会当成通道坏了
    expect(row.error).toBe('')
    expect(row.state).toBe('failed')
  })

  it('没有退出码（code=null）不算成功：与「退出码 0」必须能区分', async () => {
    const fake = makeHub()
    const batch = useBatchExec(fake.hub)

    const done = batch.run([node('a')], 'kill -9 $$')
    await flush()
    fake.emitExit(0, null)
    fake.emitData(0, '', true)
    await done

    const row = batch.rows.value[0]
    expect(row.code).toBeNull()
    expect(row.state).toBe('failed')
  })

  it('通道级错误与「非零退出」分开记：连不上要能一眼看出来', async () => {
    const fake = makeHub()
    const batch = useBatchExec(fake.hub)

    const done = batch.run([node('a')], 'uptime')
    await flush()
    fake.emitError(0, '认证失败')
    await done

    const row = batch.rows.value[0]
    expect(row.error).toBe('认证失败')
    expect(row.state).toBe('failed')
    expect(fake.closed).toHaveLength(1)
  })

  it('跨帧的半个 UTF-8 字符能拼回来（不能变成 U+FFFD）', async () => {
    const fake = makeHub()
    const batch = useBatchExec(fake.hub)

    const done = batch.run([node('a')], 'echo 中文')
    await flush()
    const bytes = encoder.encode('中文')
    // 故意在第 2 个字节处切开：一个汉字 3 字节，切点落在字符中间
    fake.specs[0].onData(bytes.subarray(0, 2), false, false)
    fake.specs[0].onData(bytes.subarray(2), false, false)
    fake.emitExit(0, 0)
    fake.emitData(0, '', true)
    await done

    expect(batch.rows.value[0].stdout).toBe('中文')
  })

  it('服务端标记的截断如实透到行上（内容不完整必须说出来）', async () => {
    const fake = makeHub()
    const batch = useBatchExec(fake.hub)

    const done = batch.run([node('a')], 'flood 5242880')
    await flush()
    fake.emitExit(0, 0, { truncated_stdout: true })
    fake.emitData(0, '', true)
    await done

    expect(batch.rows.value[0].truncatedStdout).toBe(true)
  })
})

describe('useBatchExec：并发与取消', () => {
  it('并发数受服务端通道上限约束（留一个给终端）', async () => {
    const fake = makeHub(4) // 上限 4 → 批量最多 3 路
    const batch = useBatchExec(fake.hub)

    const pending = batch.run(
      [node('a'), node('b'), node('c'), node('d'), node('e')],
      'uptime',
    )
    await flush()

    expect(batch.concurrency.value).toBe(3)
    expect(fake.specs).toHaveLength(3)

    // 放行一路，才会补开下一路
    fake.emitData(0, '', true)
    await flush()
    expect(fake.specs).toHaveLength(4)

    batch.cancel()
    await pending
  })

  it('cancel 收尾在跑的、清掉排队的，且不再开新通道', async () => {
    const fake = makeHub(2) // 并发 1（保留 1 个额度给终端）
    const batch = useBatchExec(fake.hub)

    const pending = batch.run([node('a'), node('b')], 'sleep 100')
    await flush()
    expect(fake.specs).toHaveLength(1)

    batch.cancel()
    await pending

    expect(batch.rows.value.map((r) => r.state)).toEqual(['cancelled', 'cancelled'])
    // 排队那个从头到尾没被开过通道：取消就该真的什么都不做
    expect(fake.specs).toHaveLength(1)
    expect(fake.closed).toHaveLength(1)
    expect(batch.running.value).toBe(false)
  })

  it('上一轮没跑完就点第二次：旧的一轮立刻收手，行不会被两轮混写', async () => {
    const fake = makeHub(2)
    const batch = useBatchExec(fake.hub)

    const first = batch.run([node('a')], 'sleep 100')
    await flush()
    expect(fake.specs).toHaveLength(1)

    const second = batch.run([node('b')], 'uptime')
    await first // 旧一轮必须结束，不能吊着
    await flush()

    expect(batch.rows.value).toHaveLength(1)
    expect(batch.rows.value[0].node.host).toBe('b')

    fake.emitExit(1, 0)
    fake.emitData(1, '', true)
    await second
    expect(batch.rows.value[0].state).toBe('done')
  })
})
