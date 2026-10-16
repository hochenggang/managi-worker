<template>
  <div class="file-manager" :class="{ progress: isUploading || isDownloading }">
      <div class="toolbar">
        <div class="path-navigator" @click="enterPathEditMode">
          <input v-if="pathEditing" ref="pathInputEl" v-model="pathInputValue" class="path-input" type="text"
            @keyup.enter="commitPath" @keyup.esc="cancelPathEdit" @blur="cancelPathEdit" @click.stop />
          <span v-for="(part, index) in currentPathParts" v-else :key="index" @click.stop="navigateTo(index)"
            class="path-part small-button">
            {{ part }}
          </span>
        </div>
        <div class="actions">
          <button class="small-button" @click="refresh" :title="t('finder.actions.reflush')">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>
          <button class="small-button" @click="createFolder" :title="t('finder.actions.newDir')">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z" />
            </svg>
          </button>
          <button class="small-button" @click="uploadFile" :disabled="isUploading"
            :class="{ uploading: isUploading }" :title="t('finder.actions.upload')">
            <svg v-if="!isUploading" viewBox="0 0 24 24" width="16" height="16">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            <CirclePercent v-else :percent="uploadProgress" />
          </button>
          <button class="small-button" @click="downloadSelected"
            :disabled="!selectedFile || selectedFile.is_dir || isDownloading"
            :title="t('finder.actions.download')">
            <svg v-if="!isDownloading" viewBox="0 0 24 24" width="16" height="16">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
            </svg>
            <CirclePercent v-else :percent="downloadProgress" />
          </button>
          <button class="small-button" @click="deleteSelected" :disabled="!selectedFile"
            :title="t('finder.actions.delete')">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            </svg>
          </button>
        </div>
      </div>

      <div class="file-list" @click.prevent="clearSelection">
        <div class="file-list-header">
          <div class="file-name">{{ t('finder.filename') }}</div>
          <div class="file-size">{{ t('finder.size') }}</div>
          <div class="file-modified">{{ t('finder.mtime') }}</div>
        </div>

        <!-- 不加 out-in 淡入淡出：隐藏标签页里 CSS transition 不推进、transitionend 永不到来，
             列表会卡在「空文件夹」的 leave 状态而整块不渲染。目录列表的正确性优先于这一下淡入。 -->
        <div v-if="loading" key="loading" class="loading">
          {{ t('finder.loading') }}
        </div>

        <div v-else-if="files.length === 0" key="empty" class="empty-folder">
          {{ t('finder.empty') }}
        </div>

        <div v-else key="items" class="file-items">
          <div v-show="currentPath.length > 1" class="file-item directory" @dblclick="navigateUp">
            <div class="file-icon">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
              </svg>
            </div>
            <div class="file-name">{{ t('finder.upDir') }}</div>
            <div class="file-size">-</div>
            <div class="file-modified">-</div>
          </div>

          <div v-for="(file, index) in files" :key="file.filename" class="file-item" :class="{
            'selected': selectedFile && selectedFile.filename === file.filename,
            'directory': file.is_dir
          }" :style="{ '--file-index': index }" @click.stop="selectFile(file)"
            @dblclick.stop="handleFileDoubleClick(file)">
            <div class="file-icon">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <path v-if="file.is_dir"
                  d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
                <path v-else
                  d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z" />
              </svg>
            </div>
            <div class="file-name">{{ file.filename }}</div>
            <div class="file-size">{{ formatFileSize(file.size) }}</div>
            <div class="file-modified">{{ formatDate(file.mtime) }}</div>
          </div>
        </div>
      </div>

      <div class="status-bar">
        <div class="status-info">
          {{ t("finder.total") }} {{ files.length }} {{ t("finder.item") }}
          {{ selectedFile ? `${t("finder.current")}${selectedFile.is_dir ? t("finder.dir") : t("finder.file")} ${getFullPath(selectedFile.filename)}` : "" }}
        </div>
        <div class="selected-info">
          <span>{{ props.node.name }}</span>
          <span v-if="statusText" :class="['sftp-status', 'status-line', statusClass]"><i class="status-dot"
              aria-hidden="true"></i>{{ statusText }}</span>
        </div>
      </div>

      <Transition name="finder-dialog">
      <div v-if="showCreateFolderDialog" class="dialog-overlay">
        <Transition name="finder-dialog-content" appear>
        <div class="dialog">
          <div class="dialog-header">
            {{ t("finder.actions.newDir") }}
            <button class="small-button close-btn" @click="showCreateFolderDialog = false">×</button>
          </div>
          <div class="dialog-body">
            <input v-model="newFolderName" type="text" :placeholder="t('finder.newDirPlaceholder')"
              @keyup.enter="confirmCreateFolder" />
          </div>
          <div class="dialog-footer">
            <button @click="showCreateFolderDialog = false">{{ t("finder.cancle") }}</button>
            <button class="sucess" @click="confirmCreateFolder" :disabled="!newFolderName">{{ t("finder.ok") }}</button>
          </div>
        </div>
        </Transition>
      </div>
      </Transition>

      <input type="file" ref="fileInput" style="display: none" @change="handleFileUpload" multiple />
    </div>
</template>

<script setup lang="ts">
// SFTP 文件管理器：基于 useSFTP composable（共享 /ws 上的一路 SFTP 通道）。
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import CirclePercent from '@/components/CirclePercent.vue'
import { useSFTP, LARGE_FILE_THRESHOLD } from '@/composables/useSFTP'
import { useConfirm } from '@/composables/useConfirm'
import { handleError, handleMsg, toErrorMessage } from '@/helper'
import type { ApiNode } from '@/protocol/types'
import type { SFTPFile } from '@/protocol/sftp'
import type { ConnectionStatus } from '@/composables/useWSHub'

const props = defineProps<{ node: ApiNode }>()
const { t } = useI18n()

const {
  currentPath, files, loading, uploadProgress, downloadProgress,
  status, list, upload, download, downloadViaHTTP, mkdir, del, close,
} = useSFTP(props.node)

const selectedFile = ref<SFTPFile | null>(null)
const showCreateFolderDialog = ref(false)
const newFolderName = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const isUploading = ref(false)
const isDownloading = ref(false)

// 路径编辑模式：点击 path-navigator 缝隙时切换为 input，回车提交、Esc/blur 取消
const pathEditing = ref(false)
const pathInputValue = ref('')
const pathInputEl = ref<HTMLInputElement | null>(null)

const enterPathEditMode = (): void => {
  pathInputValue.value = normalizePath(currentPath.value)
  pathEditing.value = true
  nextTick(() => {
    const el = pathInputEl.value
    if (!el) return
    el.focus()
    // 光标置于末尾，不选中全部路径
    const len = el.value.length
    el.setSelectionRange(len, len)
  })
}

const commitPath = (): void => {
  const target = normalizePath(pathInputValue.value)
  pathEditing.value = false
  // 路径未变化时无需请求
  if (target === normalizePath(currentPath.value)) return
  list(target).catch((e) => handleError(String(e)))
}

const cancelPathEdit = (): void => {
  pathEditing.value = false
}

// 连接状态 UI：断开/重连/开不起来都得让用户看见，否则只剩一个不动的目录列表。
const statusText = computed(() => {
  const map: Record<ConnectionStatus, string> = {
    idle: '',
    connecting: t('finder.connecting'),
    connected: t('finder.connected'),
    reconnecting: t('finder.reconnecting'),
    failed: t('finder.error'),
  }
  return map[status.value]
})
const statusClass = computed(() => {
  const map: Record<ConnectionStatus, string> = {
    idle: '',
    connecting: 'connecting',
    connected: 'connected',
    reconnecting: 'connecting',
    failed: 'failed',
  }
  return map[status.value]
})

// 路径规范化。折叠多个连续斜杠、去除尾部斜杠（根 '/' 除外）。
// navigateTo 原用 join('/') 会产生 '//foo//bar/' 双斜杠；navigateUp 对带尾斜杠的路径会错算层级。
function normalizePath(p: string): string {
  const collapsed = p.replace(/\/+/g, '/')
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

const getFullPath = (filename: string): string => {
  return normalizePath(`${currentPath.value}/${filename}`)
}

const refresh = async () => {
  try {
    await list(normalizePath(currentPath.value))
  } catch (e) {
    handleError(String(e))
  }
}

const navigateUp = () => {
  const normalized = normalizePath(currentPath.value)
  if (normalized === '/') return
  const parts = normalized.split('/').filter((p) => p !== '')
  parts.pop()
  list('/' + parts.join('/')).catch((e) => handleError(String(e)))
}

const navigateTo = (index: number) => {
  const newPath = normalizePath(currentPathParts.value.slice(0, index + 1).join('/'))
  list(newPath).catch((e) => handleError(String(e)))
}

const handleFileDoubleClick = (file: SFTPFile) => {
  if (file.is_dir) {
    list(getFullPath(file.filename)).catch((e) => handleError(String(e)))
  }
}

const selectFile = (file: SFTPFile) => {
  selectedFile.value = file
}

const clearSelection = () => {
  selectedFile.value = null
}

const createFolder = () => {
  showCreateFolderDialog.value = true
  newFolderName.value = ''
}

const confirmCreateFolder = async () => {
  if (!newFolderName.value) return
  const path = getFullPath(newFolderName.value)
  try {
    await mkdir(path)
    showCreateFolderDialog.value = false
    await refresh()
  } catch (e) {
    handleError(String(e))
  }
}

const uploadFile = () => {
  fileInput.value?.click()
}

const handleFileUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  isUploading.value = true
  // 隔离单文件错误，失败项记录后继续上传剩余文件
  const failedFiles: string[] = []
  try {
    for (const file of Array.from(input.files)) {
      try {
        await upload(currentPath.value, file)
      } catch (err) {
        // 带上失败原因：只报文件名时，磁盘满/权限不足/连接断看起来一模一样
        failedFiles.push(`${file.name}: ${toErrorMessage(err)}`)
      }
    }
    if (failedFiles.length > 0) {
      handleError(`${t('finder.uploadFailed')}: ${failedFiles.join(', ')}`)
    } else {
      handleMsg(t('finder.uploaded'))
    }
    await refresh()
  } finally {
    isUploading.value = false
  }
  input.value = ''
}

const downloadSelected = async () => {
  if (!selectedFile.value || selectedFile.value.is_dir) return
  isDownloading.value = true
  const path = getFullPath(selectedFile.value.filename)
  try {
    // 大文件走 HTTP Range 流式下载，避免 WS 缓冲超限
    if (selectedFile.value.size > LARGE_FILE_THRESHOLD) {
      await downloadViaHTTP(path)
    } else {
      await download(path)
    }
    handleMsg(t('finder.downloaded'))
  } catch (e) {
    handleError(String(e))
  } finally {
    isDownloading.value = false
  }
}

const { confirm } = useConfirm()

const deleteSelected = async () => {
  if (!selectedFile.value) return
  // 用 Modal 确认对话框替代原生 confirm()
  if (await confirm(`${t("finder.deleteConfire")}\n${selectedFile.value.filename}`)) {
    const path = getFullPath(selectedFile.value.filename)
    try {
      await del(path)
      selectedFile.value = null
      await refresh()
    } catch (e) {
      handleError(String(e))
    }
  }
}

const formatFileSize = (bytes: number): string => {
  // 负数/零归一为 0 B；Math.min 防止极大文件越界；sizes 补 PB
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatDate = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleString()
}

const currentPathParts = computed(() => {
  const parts = currentPath.value.split('/').filter(part => part !== '').map(part => `${part}/`)
  return ['/'].concat(parts)
})

// 首屏目录列表由 useSFTP 在通道就绪后自动发出（起始目录用服务端报出的 home）。
onBeforeUnmount(() => {
  close()
})
</script>

<style scoped>
.file-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--color-panel-bg);
  overflow: hidden;
}

.progress {
  cursor: progress;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 2.5rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-font-1);
  background-color: var(--color-panel-bg);
  flex-shrink: 0;
}

.path-navigator {
  flex: 1;
  display: flex;
  padding: 0 0.25rem;
  margin-right: 1rem;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: 0;
  white-space: nowrap;
  overflow-x: auto;
  min-width: 10rem;
  height: 1.75rem;
}

.path-part {
  flex-shrink: 0;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 0;
  margin-right: 2px;
  font-size: 0.85rem;
}

.path-part:hover {
  background-color: var(--color-hover-bg);
}

.path-input {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-font-1);
  font-size: 0.85rem;
  padding: 0 4px;
  text-align: left;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.actions button {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: auto;
  height: auto;
  padding: 0.25rem;
}

.actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.actions button svg {
  fill: var(--color-font-1);
}

.actions button:hover svg {
  fill: var(--color-accent);
}

.uploading {
  cursor: progress;
}

.file-list {
  flex: 1;
  overflow-y: auto;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-panel-bg);
  min-height: 0;
}

.file-list-header {
  display: flex;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  font-weight: bold;
  position: sticky;
  top: 0;
  z-index: 1;
  background-color: var(--color-panel-bg);
  color: var(--color-font-2);
  font-size: 0.85rem;
}

.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

.file-size {
  width: 100px;
  text-align: right;
  padding-right: 1rem;
}

.file-modified {
  width: 160px;
}

.file-items {
  padding-bottom: 2rem;
}

.file-item {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  font-size: 0.85rem;
  /* 进入目录时逐行错峰浮现；delay 上限 0.24s，长列表不会等最后一行 */
  animation: file-item-in 0.18s ease-out backwards;
  animation-delay: min(calc(var(--file-index, 0) * 8ms), 0.24s);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}

@keyframes file-item-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

.file-item:hover {
  background-color: var(--color-hover-bg);
  box-shadow: inset 2px 0 0 var(--color-accent);
}

.file-item.selected {
  background-color: var(--color-selected-bg);
  box-shadow: inset 2px 0 0 var(--color-accent);
}

.file-icon {
  width: 24px;
  height: 24px;
  margin-right: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-icon svg {
  fill: var(--color-font-2);
}

.directory .file-icon svg {
  fill: var(--color-accent);
}

.loading,
.empty-folder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20rem;
  color: var(--color-font-3);
}

.status-bar {
  height: 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 0.75rem;
  font-size: 0.75rem;
  color: var(--color-font-2);
  background-color: var(--color-panel-bg);
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.selected-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 修复 B23：SFTP 连接状态指示器 */
.sftp-status {
  padding: 0 0.35rem;
  border-radius: 0;
  font-size: 0.7rem;
}
.sftp-status.connecting { color: var(--color-yellow); }
.sftp-status.connected { color: var(--color-green); }
.sftp-status.failed { color: var(--color-red); }

.dialog-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background-color: var(--color-surface);
  border-radius: 0;
  width: 26rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  border: 1px solid var(--color-border);
}

.dialog-header {
  padding: 1rem;
  border-bottom: 1px solid var(--color-border);
  font-weight: bold;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--color-font-1);
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: var(--color-font-3);
}

.dialog-body {
  padding: 1rem;
}

.dialog-body input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 0;
  background-color: var(--color-input-bg);
  color: var(--color-font-1);
}

.dialog-footer {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-footer button {
  padding: 0.35rem 0.75rem;
  border-radius: 0;
  cursor: pointer;
}

/* 新建文件夹对话框遮罩淡入淡出 */
.finder-dialog-enter-active,
.finder-dialog-leave-active {
  transition: opacity 0.2s ease;
}

.finder-dialog-enter-from,
.finder-dialog-leave-to {
  opacity: 0;
}

/* 对话框内容缩放上浮 */
.finder-dialog-content-enter-active {
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
}

.finder-dialog-content-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(1rem);
}
</style>
