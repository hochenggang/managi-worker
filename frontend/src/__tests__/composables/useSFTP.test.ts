import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import type { ApiNode } from '@/protocol/types'
import type { FakeChannel, FakeHub } from '../helpers/fakeHub'
import { createFakeHub } from '../helpers/fakeHub'

// 链路层（握手/重连/seq 关联/帧路由）由 useWSHub.test.ts 覆盖，
// 这里只验字节流的组织方式：占位、切片、续传、进度与落定信号。

const { mockHandleError, mockDownloadWithRange, hubRef } = vi.hoisted(() => ({
  mockHandleError: vi.fn(),
  mockDownloadWithRange: vi.fn(),
  hubRef: { hub: null as any },
}))

vi.mock('@/helper', async (importActual) => ({
  ...(await importActual<typeof import('@/helper')>()),
  handleError: mockHandleError,
}))

vi.mock('@/api', () => ({
  downloadWithRange: mockDownloadWithRange,
}))

// 只替换取单例的入口，uiStatus 保持真实实现
vi.mock('@/composables/useWSHub', async (importActual) => ({
  ...(await importActual<typeof import('@/composables/useWSHub')>()),
  useWSHub: () => hubRef.hub,
}))

import { useSFTP } from '@/composables/useSFTP'

const node: ApiNode = {
  name: 'n1',
  host: '1.2.3.4',
  port: 22,
  username: 'root',
  auth_type: 'password',
  auth_value: 'pwd',
}

let fake!: FakeHub

function withSetup<T>(composable: () => T): T {
  let result!: T
  const App = defineComponent({
    setup() {
      result = composable()
      return () => h('div')
    },
  })
  mount(App)
  return result
}

/** 挂一路文件管理并把通道置为就绪；就绪后 useSFTP 自行列出起始目录。 */
function mountSFTP(home = '/home/user'): { s: ReturnType<typeof useSFTP>; chan: FakeChannel } {
  const s = withSetup(() => useSFTP(node))
  const chan = fake.channel()
  chan.ready({ kind: 'sftp', home })
  return { s, chan }
}

/** 结清通道就绪时自动发出的那次列目录。 */
async function settleAutoList(chan: FakeChannel, path: string): Promise<void> {
  chan.lastRequest('ls').ok({ path, files: [] })
  await nextTick()
}

const file = (name: string, size: number, mtime = 0) =>
  new File([new Uint8Array(size)], name, { lastModified: mtime })

/** 打桩 File System Access：happy-dom 没有 showSaveFilePicker，测试里按需给一个。 */
function stubPicker(impl: (() => Promise<any>) | undefined): void {
  Object.defineProperty(window, 'showSaveFilePicker', { value: impl, configurable: true, writable: true })
}

const streamOf = (sizes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      sizes.forEach((n) => c.enqueue(new Uint8Array(n)))
      c.close()
    },
  })

describe('useSFTP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDownloadWithRange.mockReset()
    stubPicker(undefined)
    fake = createFakeHub()
    hubRef.hub = fake
  })

  it('attach 一路 SFTP 通道，open 负载只带节点描述', () => {
    withSetup(() => useSFTP(node))
    expect(fake.channel().spec.openData()).toEqual({ kind: 'sftp', node })
  })

  // 硬编码 '/' 起步会让没有根目录读权限的账号一进来就报错
  it('通道就绪后按服务端报出的 home 列首个目录', async () => {
    const { s, chan } = mountSFTP('/srv/data')
    expect(chan.lastRequest('ls').data).toEqual({ path: '/srv/data', chan: 1 })
    await settleAutoList(chan, '/srv/data')
    expect(s.currentPath.value).toBe('/srv/data')
  })

  it('list 写入 files/currentPath 并复位 loading', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.list('/etc')
    expect(s.loading.value).toBe(true)
    expect(chan.lastRequest('ls').data).toEqual({ path: '/etc', chan: 1 })
    chan.lastRequest('ls').ok({
      path: '/etc',
      files: [{ filename: 'hosts', size: 10, mode: '0644', is_dir: false, mtime: 1 }],
    })
    await p
    expect(s.files.value[0].filename).toBe('hosts')
    expect(s.currentPath.value).toBe('/etc')
    expect(s.loading.value).toBe(false)
  })

  it('响应缺 files 时按空目录处理，不把 undefined 塞进列表', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')
    const p = s.list('/empty')
    chan.lastRequest('ls').ok({ path: '/empty' })
    await p
    expect(s.files.value).toEqual([])
  })

  // 空路径会让服务端按别的工作目录列，界面却显示成空——直接挡在门口
  it('list 拒绝空路径，不发请求', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')
    const before = chan.requests.length
    await expect(s.list('')).rejects.toThrow('路径不能为空')
    expect(chan.requests).toHaveLength(before)
  })

  it('mkdir 与删除走控制面，删除用 rm 动词', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const m = s.mkdir('/home/user/new')
    expect(chan.lastRequest('mkdir').data).toEqual({ path: '/home/user/new', chan: 1 })
    chan.lastRequest('mkdir').ok({ path: '/home/user/new' })
    await m

    const d = s.del('/home/user/hosts')
    expect(chan.lastRequest('rm').data).toEqual({ path: '/home/user/hosts', chan: 1 })
    chan.lastRequest('rm').ok({ path: '/home/user/hosts' })
    await d
  })

  it('upload：请求 → 按服务端 chunk_size 分帧 → 空帧 FLAG_END → upload_end 落定', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.upload('/remote', file('t.bin', 10, 1728000000000))
    expect(chan.lastRequest('upload').data).toEqual({
      path: '/remote',
      filename: 't.bin',
      size: 10,
      mtime: 1728000000000,
      chan: 1,
    })
    chan.lastRequest('upload').ok({ offset: 0, chunk_size: 4 })

    await vi.waitFor(() => expect(chan.frames.length).toBe(4))
    expect(chan.frames.map((f) => [f.payload.byteLength, f.end])).toEqual([
      [4, false],
      [4, false],
      [2, false],
      [0, true],
    ])
    // 每片发送前都等过一次窗口放行：慢链路下不会把整个文件堆进浏览器发送队列
    expect(chan.ackWaits).toBe(3)

    chan.emit('upload_end', { chan: 1, size: 10 })
    await expect(p).resolves.toBeUndefined()
    expect(s.uploadProgress.value).toBe(100)
  })

  // 服务端积压中止通道时会先回 error 再放行走完的等待者：上传循环必须在复核点收手，
  // 否则会对着一条不会再回 ack 的死通道永远发下去
  it('等窗口期间通道出错：以该错误收尾，不再续发数据帧', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')
    chan.holdAcks() // 第一片起就挂在窗口上

    const p = s.upload('/remote', file('t.bin', 10))
    chan.lastRequest('upload').ok({ offset: 0, chunk_size: 4 })
    await vi.waitFor(() => expect(chan.ackWaits).toBe(1))
    expect(chan.frames).toHaveLength(0)

    chan.emit('error', { chan: 1, message: '上传输入积压超过窗口，通道已中止' })
    await expect(p).rejects.toThrow('积压')
    expect(chan.frames).toHaveLength(0) // 死通道上一片也不发
  })

  // 服务端报了续传点：已落盘的字节不重发
  it('upload 从服务端给出的 offset 续传', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.upload('/remote', file('big.bin', 10))
    chan.lastRequest('upload').ok({ offset: 4, chunk_size: 4 })
    await vi.waitFor(() => expect(chan.frames.length).toBe(3))
    expect(chan.frames.map((f) => [f.payload.byteLength, f.end])).toEqual([
      [4, false],
      [2, false],
      [0, true],
    ])

    chan.emit('upload_end', { size: 10 })
    await p
    expect(s.uploadProgress.value).toBe(100)
  })

  // 0 或缺失的 chunk_size 会让切片步长为 0，上传循环永不结束
  it('upload 拒绝服务端给出的非法切片大小，且不发数据帧', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.upload('/r', file('guard.bin', 4))
    chan.lastRequest('upload').ok({ offset: 0, chunk_size: 0 })
    await expect(p).rejects.toThrow(/非法切片大小/)
    expect(chan.frames).toHaveLength(0)
  })

  // 交错两路字节流只会得到内容错乱的文件：一路通道同时只跑一路
  it('同一通道同时只允许一路传输', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const first = s.upload('/r', file('a.bin', 8))
    await expect(s.upload('/r', file('b.bin', 8))).rejects.toThrow('上一个传输尚未完成')

    chan.lastRequest('upload').err('清理：断开')
    await expect(first).rejects.toThrow('清理：断开')
  })

  it('传输在途时链路断开：等待者立即失败，不留悬等', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.upload('/r', file('a.bin', 8))
    chan.lastRequest('upload').ok({ offset: 0, chunk_size: 4 })
    await vi.waitFor(() => expect(chan.frames.length).toBeGreaterThan(0))

    chan.lost()
    await expect(p).rejects.toThrow(/连接已断开|通道尚未就绪|断开/)
  })

  it('服务端 error 推送判给在途传输，写盘失败不会让调用方干等', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.upload('/r', file('a.bin', 8))
    chan.lastRequest('upload').ok({ offset: 0, chunk_size: 4 })
    await vi.waitFor(() => expect(chan.frames.length).toBeGreaterThan(0))

    chan.emit('error', { chan: 1, message: 'write .part: no space' })
    await expect(p).rejects.toThrow('no space')
    expect(mockHandleError).not.toHaveBeenCalled()
  })

  it('没有传输在跑时的 error 推送出声给用户', async () => {
    const { chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')
    chan.emit('error', { chan: 1, message: 'sftp: connection reset' })
    expect(mockHandleError).toHaveBeenCalledWith('sftp: connection reset')
  })

  it('download：请求 → 数据帧累计进度 → FLAG_END 触发落盘并复位', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')

    const p = s.download('/remote/file.txt')
    expect(chan.lastRequest('download').data).toEqual({ path: '/remote/file.txt', chan: 1 })
    chan.lastRequest('download').ok({ filename: 'file.txt', total: 6 })
    await nextTick() // total 是在响应回调里落的，先让它生效

    chan.push(new Uint8Array([1, 2, 3]))
    expect(s.downloadProgress.value).toBe(50)
    chan.push(new Uint8Array([4, 5, 6]), true)
    await p
    // 落盘后复位，工具栏回到普通下载图标
    expect(s.downloadProgress.value).toBe(0)
  })

  it('download 未启动时到达的数据帧被丢弃，不污染进度', () => {
    const { s, chan } = mountSFTP()
    chan.push(new Uint8Array([1, 2, 3]))
    expect(s.downloadProgress.value).toBe(0)
  })

  it('close 了结在途传输并摘除通道', async () => {
    const { s, chan } = mountSFTP()
    const p = s.download('/remote/f')
    chan.lastRequest('download').ok({ filename: 'f', total: 4 })
    await nextTick()

    s.close()
    await expect(p).rejects.toThrow('文件管理已关闭')
    expect(chan.closeCalls).toBe(1)
  })

  // 界面态 = 链路态 + 通道态：WS 通着不代表 SFTP 已可用
  it('status 折叠链路态与通道态', async () => {
    const { s, chan } = mountSFTP()
    await settleAutoList(chan, '/home/user')
    expect(s.status.value).toBe('connected')

    chan.lost()
    await nextTick()
    expect(s.status.value).toBe('connecting')

    fake.status.value = 'reconnecting'
    expect(s.status.value).toBe('reconnecting')

    fake.status.value = 'connected'
    chan.ready({ kind: 'sftp', chan: 3, home: '/home/user' })
    await settleAutoList(chan, '/home/user')
    expect(s.status.value).toBe('connected')
  })

  // 重连后回到用户当前所在目录，而不是把他弹回主目录
  it('重开后重新列出当前目录而非 home', async () => {
    const { s, chan } = mountSFTP('/home/user')
    await settleAutoList(chan, '/home/user')
    const p = s.list('/var/log')
    chan.lastRequest('ls').ok({ path: '/var/log', files: [] })
    await p

    chan.lost()
    chan.ready({ kind: 'sftp', chan: 5, home: '/home/user' })
    expect(chan.lastRequest('ls').data).toEqual({ path: '/var/log', chan: 5 })
    await settleAutoList(chan, '/var/log')
    expect(s.currentPath.value).toBe('/var/log')
  })

  it('downloadViaHTTP：分块读取流并按字节数推进度', async () => {
    const { s } = mountSFTP()
    const chunks = [new Uint8Array(50), new Uint8Array(50)]
    let i = 0
    mockDownloadWithRange.mockResolvedValue({
      total: 100,
      stream: new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < chunks.length) c.enqueue(chunks[i++])
          else c.close()
        },
      }),
    })
    await s.downloadViaHTTP('/big.bin')
    expect(s.downloadProgress.value).toBe(100)
  })

  it('downloadViaHTTP 失败时复位进度，不残留半截数字', async () => {
    const { s } = mountSFTP()
    mockDownloadWithRange.mockResolvedValue({
      total: 100,
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(50))
        },
        pull() {
          throw new Error('network interrupted')
        },
      }),
    })
    await expect(s.downloadViaHTTP('/big.bin')).rejects.toThrow('network interrupted')
    expect(s.downloadProgress.value).toBe(0)
  })

  // 有 File System Access 就逐块写盘：GB 级文件不该先变成浏览器内存里的一个 Blob
  it('downloadViaHTTP：走磁盘写入，不缓冲整份文件', async () => {
    const { s } = mountSFTP()
    const written: number[] = []
    const writable = {
      write: vi.fn(async (c: Uint8Array) => {
        written.push(c.byteLength)
      }),
      close: vi.fn(),
      abort: vi.fn(),
    }
    const picker = vi.fn(async () => ({ createWritable: async () => writable }))
    stubPicker(picker)
    mockDownloadWithRange.mockResolvedValue({ total: 100, stream: streamOf([50, 50]) })

    await s.downloadViaHTTP('/dir/big.bin')
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'big.bin' })
    expect(written).toEqual([50, 50])
    expect(writable.close).toHaveBeenCalledTimes(1)
    expect(writable.abort).not.toHaveBeenCalled()
    expect(s.downloadProgress.value).toBe(100)
  })

  // 取消保存框是用户意愿，不该变成一次失败的下载，更不该再去拉数据
  it('downloadViaHTTP：用户取消保存框则静默结束', async () => {
    const { s } = mountSFTP()
    stubPicker(async () => {
      throw Object.assign(new Error('canceled'), { name: 'AbortError' })
    })
    await expect(s.downloadViaHTTP('/big.bin')).resolves.toBeUndefined()
    expect(mockDownloadWithRange).not.toHaveBeenCalled()
    expect(s.downloadProgress.value).toBe(0)
  })

  // 写盘失败必须 abort()：否则半截文件会被当成完整的一份留在盘上
  it('downloadViaHTTP 写盘失败：abort 丢弃半成品并复位进度', async () => {
    const { s } = mountSFTP()
    const writable = {
      write: vi.fn(async (c: Uint8Array) => {
        if (c.byteLength > 40) throw new Error('disk full')
      }),
      close: vi.fn(),
      abort: vi.fn(async () => {}),
    }
    stubPicker(async () => ({ createWritable: async () => writable }))
    mockDownloadWithRange.mockResolvedValue({ total: 100, stream: streamOf([40, 60]) })

    await expect(s.downloadViaHTTP('/big.bin')).rejects.toThrow('disk full')
    expect(writable.abort).toHaveBeenCalledTimes(1)
    expect(writable.close).not.toHaveBeenCalled()
    expect(s.downloadProgress.value).toBe(0)
  })
})
