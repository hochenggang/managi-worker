import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import Finder from '@/components/Finder.vue'
import type { ApiNode } from '@/protocol/types'
import type { ConnectionStatus } from '@/composables/useWSHub'

// 持有 useSFTP 返回的响应式引用，供测试中控制状态
const mockCurrentPath = ref('/')
const mockFiles = ref<any[]>([])
const mockLoading = ref(false)
const mockUploadProgress = ref(0)
const mockDownloadProgress = ref(0)
const mockStatus = ref<ConnectionStatus>('connected')
const mockList = vi.fn(() => Promise.resolve())
const mockUpload = vi.fn(() => Promise.resolve())
const mockDownload = vi.fn(() => Promise.resolve())
const mockDownloadViaHTTP = vi.fn(() => Promise.resolve())
const mockMkdir = vi.fn(() => Promise.resolve())
const mockDel = vi.fn(() => Promise.resolve())
const mockClose = vi.fn()

vi.mock('@/composables/useSFTP', () => ({
  useSFTP: () => ({
    currentPath: mockCurrentPath,
    files: mockFiles,
    loading: mockLoading,
    uploadProgress: mockUploadProgress,
    downloadProgress: mockDownloadProgress,
    status: mockStatus,
    list: mockList,
    upload: mockUpload,
    download: mockDownload,
    downloadViaHTTP: mockDownloadViaHTTP,
    mkdir: mockMkdir,
    del: mockDel,
    close: mockClose,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/helper', () => ({
  handleError: vi.fn(),
  handleMsg: vi.fn(),
}))

vi.mock('@/components/CirclePercent.vue', () => ({
  default: {
    name: 'CirclePercent',
    props: ['percent'],
    template: '<div class="circle-percent" />',
  },
}))

const node: ApiNode = {
  name: 'n1',
  host: '1.2.3.4',
  port: 22,
  username: 'root',
  auth_type: 'password',
  auth_value: 'pwd',
}

function mountFinder() {
  return mount(Finder, { props: { node } })
}

describe('Finder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCurrentPath.value = '/'
    mockFiles.value = []
    mockLoading.value = false
    mockUploadProgress.value = 0
    mockDownloadProgress.value = 0
    mockStatus.value = 'connected'
    mockList.mockResolvedValue(undefined)
  })

  // navigateTo 不再产生双斜杠路径
  describe('path navigation (B17 fix)', () => {
    it('navigateTo builds normalized path without double slashes', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      // currentPathParts = ['/', 'foo/', 'bar/']
      // 点击 index=1 应导航到 /foo（原 bug 产生 //foo/）
      const pathParts = wrapper.findAll('.path-part')
      expect(pathParts.length).toBe(3)
      await pathParts[1].trigger('click')
      expect(mockList).toHaveBeenCalledWith('/foo')
    })

    it('navigateTo to root stays /', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      const pathParts = wrapper.findAll('.path-part')
      await pathParts[0].trigger('click')
      expect(mockList).toHaveBeenCalledWith('/')
    })

    it('navigateTo to leaf stays full path', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      const pathParts = wrapper.findAll('.path-part')
      await pathParts[2].trigger('click')
      expect(mockList).toHaveBeenCalledWith('/foo/bar')
    })

    it('navigateUp from /foo/bar goes to /foo', async () => {
      mockCurrentPath.value = '/foo/bar'
      // 需至少一个文件，v-else 分支才渲染 ".." 返回项
      mockFiles.value = [{ filename: 'a.txt', size: 1, is_dir: false, mtime: 0 }]
      const wrapper = mountFinder()
      await nextTick()
      // 双击 ".." 返回上级（第一个 .file-item.directory 是 ".."）
      const upDir = wrapper.find('.file-item.directory')
      await upDir.trigger('dblclick')
      expect(mockList).toHaveBeenCalledWith('/foo')
    })

    it('navigateUp from /foo goes to /', async () => {
      mockCurrentPath.value = '/foo'
      mockFiles.value = [{ filename: 'a.txt', size: 1, is_dir: false, mtime: 0 }]
      const wrapper = mountFinder()
      await nextTick()
      const upDir = wrapper.find('.file-item.directory')
      await upDir.trigger('dblclick')
      expect(mockList).toHaveBeenCalledWith('/')
    })

    it('navigateUp handles trailing slash correctly', async () => {
      // 服务端若返回带尾斜杠的路径，navigateUp 不应错算层级。
      // 旧 bug：/foo/bar/ → split/slice(0,-1)/join → /foo/bar（同级，错误）。
      // 修复后：先 normalize 去尾斜杠 → /foo/bar → pop → /foo（正确父级）。
      mockCurrentPath.value = '/foo/bar/'
      mockFiles.value = [{ filename: 'a.txt', size: 1, is_dir: false, mtime: 0 }]
      const wrapper = mountFinder()
      await nextTick()
      const upDir = wrapper.find('.file-item.directory')
      await upDir.trigger('dblclick')
      expect(mockList).toHaveBeenCalledWith('/foo')
    })

    it('getFullPath normalizes double slashes', async () => {
      mockCurrentPath.value = '/foo/'
      mockFiles.value = [
        { filename: 'test.txt', size: 10, is_dir: false, mtime: 0 },
      ]
      const wrapper = mountFinder()
      await nextTick()
      // 选中文件后状态栏显示完整路径，应无双斜杠
      const fileItem = wrapper.findAll('.file-item').find((el) => !el.classes('directory'))
      await fileItem!.trigger('click')
      const statusInfo = wrapper.find('.status-info').text()
      expect(statusInfo).toContain('/foo/test.txt')
      expect(statusInfo).not.toContain('//')
    })
  })

  // SFTP 连接状态在状态栏显示
  describe('connection status UI (B23 fix)', () => {
    it('shows connected status text', async () => {
      mockStatus.value = 'connected'
      const wrapper = mountFinder()
      await nextTick()
      const statusEl = wrapper.find('.sftp-status')
      expect(statusEl.exists()).toBe(true)
      expect(statusEl.text()).toBe('finder.connected')
      expect(statusEl.classes()).toContain('connected')
    })

    it('shows reconnecting status text', async () => {
      mockStatus.value = 'reconnecting'
      const wrapper = mountFinder()
      await nextTick()
      const statusEl = wrapper.find('.sftp-status')
      expect(statusEl.exists()).toBe(true)
      expect(statusEl.text()).toBe('finder.reconnecting')
      expect(statusEl.classes()).toContain('connecting')
    })

    it('shows failed status with red class', async () => {
      mockStatus.value = 'failed'
      const wrapper = mountFinder()
      await nextTick()
      const statusEl = wrapper.find('.sftp-status')
      expect(statusEl.classes()).toContain('failed')
    })

    it('hides status when idle', async () => {
      mockStatus.value = 'idle'
      const wrapper = mountFinder()
      await nextTick()
      expect(wrapper.find('.sftp-status').exists()).toBe(false)
    })

    it('updates status reactively', async () => {
      mockStatus.value = 'connected'
      const wrapper = mountFinder()
      await nextTick()
      expect(wrapper.find('.sftp-status').text()).toBe('finder.connected')
      mockStatus.value = 'reconnecting'
      await nextTick()
      expect(wrapper.find('.sftp-status').text()).toBe('finder.reconnecting')
    })
  })

  // 路径编辑模式：点击 path-navigator 缝隙切换为 input
  describe('path edit mode', () => {
    it('clicking path-navigator container enters edit mode with input', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      // 初始状态：显示 parts，无 input
      expect(wrapper.find('.path-input').exists()).toBe(false)
      expect(wrapper.findAll('.path-part').length).toBe(3)
      // 点击 path-navigator 容器（非 part）
      await wrapper.find('.path-navigator').trigger('click')
      await nextTick()
      // 进入编辑模式：显示 input，parts 消失
      expect(wrapper.find('.path-input').exists()).toBe(true)
      expect(wrapper.findAll('.path-part').length).toBe(0)
    })

    it('input is pre-filled with normalized current path', async () => {
      mockCurrentPath.value = '/foo/bar/'
      const wrapper = mountFinder()
      await nextTick()
      await wrapper.find('.path-navigator').trigger('click')
      await nextTick()
      const input = wrapper.find('.path-input').element as HTMLInputElement
      // 尾斜杠应被 normalize 去除
      expect(input.value).toBe('/foo/bar')
    })

    it('Enter commits path and calls list', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      await wrapper.find('.path-navigator').trigger('click')
      await nextTick()
      // 修改路径
      const input = wrapper.find('.path-input')
      await input.setValue('/foo/baz')
      await input.trigger('keyup.enter')
      await nextTick()
      expect(mockList).toHaveBeenCalledWith('/foo/baz')
      // 提交后恢复 parts 模式
      expect(wrapper.find('.path-input').exists()).toBe(false)
      expect(wrapper.findAll('.path-part').length).toBe(3)
    })

    it('Escape cancels edit without calling list', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      await wrapper.find('.path-navigator').trigger('click')
      await nextTick()
      const input = wrapper.find('.path-input')
      await input.setValue('/foo/baz')
      await input.trigger('keyup.esc')
      await nextTick()
      expect(mockList).not.toHaveBeenCalled()
      // 取消后恢复 parts 模式
      expect(wrapper.find('.path-input').exists()).toBe(false)
      expect(wrapper.findAll('.path-part').length).toBe(3)
    })

    it('Enter with unchanged path does not call list', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      await wrapper.find('.path-navigator').trigger('click')
      await nextTick()
      // 不修改路径直接回车
      await wrapper.find('.path-input').trigger('keyup.enter')
      await nextTick()
      expect(mockList).not.toHaveBeenCalled()
      expect(wrapper.find('.path-input').exists()).toBe(false)
    })

    it('clicking a path-part still navigates without entering edit mode', async () => {
      mockCurrentPath.value = '/foo/bar'
      const wrapper = mountFinder()
      await nextTick()
      const pathParts = wrapper.findAll('.path-part')
      await pathParts[1].trigger('click')
      await nextTick()
      // part 点击触发 navigateTo，不触发 enterPathEditMode
      expect(mockList).toHaveBeenCalledWith('/foo')
      expect(wrapper.find('.path-input').exists()).toBe(false)
    })
  })
})
