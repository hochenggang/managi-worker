// useSFTP：一路文件管理标签 = 共享 /ws 上的一路 SFTP 通道。
//
// 目录操作走控制面（一问一答，靠 seq 关联），文件字节走数据面（分片帧 + FLAG_END）。
// 断线重连由枢纽负责：通道重开成功后把用户当前所在目录重新列出来即可。
// 文件内容一律走这条 WS（没有第二条 HTTP 通道），所以上传下载都设同一个 10MB 上限。

import { computed, ref, watch } from 'vue'
import { uiStatus, useWSHub } from './useWSHub'
import { handleError, toErrorMessage } from '@/helper'
import type { ErrorData, OpenResponse, OpenSFTP } from '@/protocol/ws'
import type { DownloadData, LSData, SFTPFile, UploadData } from '@/protocol/sftp'
import type { ApiNode } from '@/protocol/types'

// 单个文件的上传与下载上限，与后端 SFTPHandler.MAX_FILE_BYTES 保持一致。
// 下载会把整份文件读进内存再落盘，10MB 是「够用又不至于顶爆标签页」的分界。
export const MAX_FILE_BYTES = 10 * 1024 * 1024
// FLAG_END 空帧的载荷：只用来表达「写完了，请落定」。
const NO_BYTES = new Uint8Array(0)

type StreamKind = 'upload' | 'download'

interface Stream {
  kind: StreamKind
  settle: (err: Error | null) => void
}

export function useSFTP(node: ApiNode) {
  const currentPath = ref('/')
  const files = ref<SFTPFile[]>([])
  const loading = ref(false)
  const uploadProgress = ref(0)
  const downloadProgress = ref(0)

  const hub = useWSHub()
  // 一路通道同时只跑一路字节流（上传或下载）：交错两路只会得到内容错乱的文件，
  // 服务端同样按此假设（第二个 upload 请求会接管前一路）。
  let stream: Stream | null = null
  // 通道级错误的最近一次原文：上传循环在等窗口期间被叫醒时据此收手，
  // 否则会对着一条已被服务端中止、不会再回 ack 的通道继续发送。
  let streamErr: Error | null = null
  let chunks: Uint8Array[] = []
  let received = 0
  let expectedTotal = 0
  let downloadName = 'download'
  let openedOnce = false
  let hostKeyWarned = false

  const channel = hub.attach({
    openData: (): OpenSFTP => ({ kind: 'sftp', node }),
    onOpen: (resp: OpenResponse) => {
      // 首连信任（TOFU）是静默发生的，而这正是中间人最舒服的位置。
      // 把刚记下的指纹亮一次，让用户有机会核对；只提示一次，不反复打扰。
      if (resp.host_key?.recorded && !hostKeyWarned) {
        hostKeyWarned = true
        handleError(`首次连接已记录主机指纹 ${resp.host_key.fingerprint}，请核对是否与该服务器一致`)
      }
      // 首开用服务端报的 home：硬编码 '/' 会让没有根目录读权限的账号一进来就报错。
      // 重连后回到用户当前所在目录，而不是把他弹回主目录。
      const target = openedOnce ? currentPath.value : resp.home || '/'
      openedOnce = true
      list(target).catch((e) => handleError(toErrorMessage(e)))
    },
    onData: (payload, end) => {
      // 只接纳下载在跑时的帧：服务端在上传方向不该发数据帧，误投的丢掉。
      if (!stream || stream.kind !== 'download') return
      if (payload.byteLength) {
        if (received + payload.byteLength > MAX_FILE_BYTES) {
          failDownload(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 下载上限`)
          return
        }
        chunks.push(payload)
        received += payload.byteLength
        downloadProgress.value = percent(received, expectedTotal)
      }
      if (!end) return
      downloadProgress.value = 100
      triggerDownload(new Blob(chunks as BlobPart[]), downloadName)
      settleStream(null)
      resetDownload()
    },
    onNotify: (type, data) => {
      if (type === 'upload_end') {
        uploadProgress.value = 100
        settleStream(null)
        return
      }
      if (type !== 'error') return
      const message = (data as ErrorData | undefined)?.message ?? 'SFTP 出错'
      // 通道级错误一律判给在途传输（写盘失败、下载被截断），否则调用方会一直等落定信号；
      // 没有传输在跑时才是真的没主的事，出声让用户看到。
      if (stream) {
        streamErr = new Error(message)
        settleStream(streamErr)
      } else {
        handleError(message)
      }
    },
  })

  // 断线/通道重开：在途传输判失败。服务端保留了 .part，重连后重发同一文件即从续传点继续。
  const stopStateWatch = watch(channel.state, (s) => {
    if (s !== 'open') settleStream(new Error('连接已断开'))
  })

  const status = computed(() => uiStatus(hub.status.value, channel.state.value))

  // ===== 字节流占位 =====

  /** startStream 占用这路字节流并返回等待落定的 Promise。
   *  必须在发出请求前占位：响应之后数据帧可能先到，届时再无主就丢掉了。
   */
  function startStream(kind: StreamKind): Promise<void> {
    if (stream) throw new Error('上一个传输尚未完成')
    let settle: (err: Error | null) => void = () => {}
    const done = new Promise<void>((resolve, reject) => {
      settle = (err) => (err ? reject(err) : resolve())
    })
    // 失败常常是调用方自己抛出来的（那条路径上没人 await done）：先认领这里的 rejection，
    // 否则传输失败会附带一条无关的 unhandled rejection 噪声。
    done.catch(() => {})
    stream = { kind, settle }
    return done
  }

  /** settleStream 了结当前字节流：err 为空即成功落定。 */
  function settleStream(err: Error | null): void {
    const s = stream
    if (!s) return
    stream = null
    s.settle(err)
  }

  function resetDownload(): void {
    chunks = []
    received = 0
    expectedTotal = 0
    downloadName = 'download'
    downloadProgress.value = 0
  }

  function failDownload(message: string): void {
    resetDownload()
    settleStream(new Error(message))
  }

  // ===== 目录操作 =====

  async function list(path: string): Promise<void> {
    if (!path) throw new Error('路径不能为空')
    loading.value = true
    try {
      const d = await channel.request<LSData>('ls', { path })
      files.value = d?.files ?? []
      currentPath.value = d?.path || path
      // 服务端有条目上限。不说出来的话，用户会以为目录里就这么多东西。
      if (d?.truncated) handleError('目录条目过多，只显示了前一部分；请用终端查看全部')
    } finally {
      loading.value = false
    }
  }

  async function mkdir(path: string): Promise<void> {
    await channel.request('mkdir', { path })
  }

  async function del(path: string): Promise<void> {
    await channel.request('rm', { path })
  }

  // ===== 上传：upload 请求 → 数据面分片 → FLAG_END 落定 → upload_end =====

  async function upload(remoteDir: string, file: File): Promise<void> {
    // 与下载同一口径：超上限直接说清楚，不把 10MB 的文件切成几千片再被服务端拒绝。
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`文件 ${formatSize(file.size)}，超过上传上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
    }
    uploadProgress.value = 0
    streamErr = null
    const done = startStream('upload')
    try {
      const init = await channel.request<UploadData>('upload', {
        path: remoteDir,
        filename: file.name,
        size: file.size,
        // mtime 与 size 一起是 .part 的续传身份：服务端据此判断旧残片是否可续
        mtime: file.lastModified,
      })
      // 切片大小由服务端定（同时是它的单帧上限），客户端不自作主张
      const chunkSize = init?.chunk_size ?? 0
      if (!(chunkSize > 0)) throw new Error(`upload: 服务端给出非法切片大小 ${chunkSize}`)

      for (let pos = init.offset ?? 0; pos < file.size; pos += chunkSize) {
        const bytes = new Uint8Array(await file.slice(pos, pos + chunkSize).arrayBuffer())
        // 先等窗口腾出这片空间再发：慢链路下不会在浏览器里堆出无界发送队列
        await channel.waitAck(bytes.byteLength)
        // 等待期间通道被判死（如服务端积压中止）：就此收手，别对着死通道续发
        if (streamErr) throw streamErr
        if (!channel.frame(bytes)) throw new Error('连接已断开')
        uploadProgress.value = percent(pos + bytes.byteLength, file.size)
      }
      if (!channel.frame(NO_BYTES, true)) throw new Error('连接已断开')
      await done
    } catch (e) {
      settleStream(toError(e))
      throw e
    }
  }

  // ===== 下载：download 请求 → 数据面分片直到 FLAG_END =====

  /** download 下载一个远端文件。
   *  size 是列表里已知的大小：先判上限，超了就直接说清楚，不必开连接白跑一趟。
   *  服务端仍会自己再判一次（列表可能是旧的）。
   */
  async function download(remotePath: string, size?: number): Promise<void> {
    if (size !== undefined && size > MAX_FILE_BYTES) {
      throw new Error(`文件 ${formatSize(size)}，超过下载上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
    }
    resetDownload()
    const done = startStream('download')
    try {
      const d = await channel.request<DownloadData>('download', { path: remotePath })
      downloadName = d?.filename || basename(remotePath)
      expectedTotal = d?.total ?? 0
      await done
    } catch (e) {
      settleStream(toError(e))
      resetDownload()
      throw e
    }
  }

  function close(): void {
    stopStateWatch()
    settleStream(new Error('文件管理已关闭'))
    channel.close()
  }

  return {
    currentPath, files, loading, uploadProgress, downloadProgress,
    status, list, upload, download, mkdir, del, close,
  }
}

/** percent 进度百分比：封顶 100（续传点与分片边界不总是对齐），总量未知时给 0。 */
function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

/** formatSize 把字节数说成人能看懂的大小（与后端 formatMB 同口径）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? 'download'
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(toErrorMessage(e))
}

function triggerDownload(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
