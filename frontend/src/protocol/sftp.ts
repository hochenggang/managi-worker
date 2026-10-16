// SFTP 控制帧的 data 负载：与后端 handler/chan_sftp.go 的请求/响应结构逐字段对齐。
// 字节本身不在这里——上传分片与下载内容走数据面二进制帧（见 ./frames.ts）。

/** 目录项（后端 model.FileItem）。size/mtime 为 int64，JS number 在 2^53 内精确。 */
export interface SFTPFile {
  filename: string
  size: number
  mode: string
  is_dir: boolean
  mtime: number
}

/** ls 响应。空目录时后端省略 files：没有条目就是没有。 */
export interface LSData {
  chan: number
  path: string
  files?: SFTPFile[]
}

/** mkdir/rm 回声操作的 path。 */
export interface PathData {
  chan: number
  path: string
}

/** upload 响应：续传点与切片大小都由服务端定，客户端不自作主张。 */
export interface UploadData {
  chan: number
  offset: number
  chunk_size: number
}

/** upload_end：服务端主动推，size 为落定后的文件字节数。 */
export interface UploadEndData {
  chan: number
  size: number
}

/** download 响应：此后该通道的数据帧即文件内容，最后一片带 FLAG_END。 */
export interface DownloadData {
  chan: number
  filename: string
  total: number
}
