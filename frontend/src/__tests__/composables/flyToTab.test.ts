import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flyToTab } from '@/composables/flyToTab'

type Rect = { left: number; top: number; width: number; height: number }

function setRect(el: Element, rect: Rect): void {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
}

function buildDom(): { from: HTMLElement; tab: HTMLElement } {
  document.body.innerHTML = `
    <div class="tabs">
      <div class="tab" data-tab-id="t1"><span class="tab-icon"><svg></svg></span></div>
    </div>
    <div class="node-actions"><svg class="icon" viewBox="0 0 24 24"></svg></div>
  `
  const from = document.querySelector('.node-actions .icon') as unknown as HTMLElement
  const tab = document.querySelector('.tab') as HTMLElement
  setRect(from as unknown as Element, { left: 100, top: 200, width: 14, height: 14 })
  setRect(tab.querySelector('.tab-icon')!, { left: 40, top: 8, width: 16, height: 16 })
  return { from, tab }
}

// 记录 animate 收到的关键帧，并在微任务后触发 onfinish 以验证幽灵清理。
// happy-dom 未实现 WAAPI，故用 defineProperty 注入/移除。
type AnimateCall = { el: Element; keyframes: unknown }
let animateCalls: AnimateCall[] = []

function stubAnimate(): void {
  animateCalls = []
  Object.defineProperty(Element.prototype, 'animate', {
    value: function (this: Element, keyframes: unknown) {
      animateCalls.push({ el: this, keyframes })
      const anim = { onfinish: null as (() => void) | null, oncancel: null as (() => void) | null }
      queueMicrotask(() => anim.onfinish?.())
      return anim
    },
    configurable: true,
    writable: true,
  })
}

function unsetAnimate(): void {
  delete (Element.prototype as unknown as { animate?: unknown }).animate
}

describe('flyToTab 图标飞入标签', () => {
  beforeEach(() => {
    stubAnimate()
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    unsetAnimate()
    document.body.innerHTML = ''
  })

  it('创建 .flying-icon 幽灵并按源矩形定位', () => {
    const { from } = buildDom()
    flyToTab(from, 't1')
    const ghost = document.querySelector('.flying-icon') as HTMLElement
    expect(ghost).toBeTruthy()
    expect(ghost.style.left).toBe('100px')
    expect(ghost.style.top).toBe('200px')
    expect(ghost.style.position).toBe('fixed')
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
  })

  it('终点位移与缩放按目标图标中心计算', () => {
    const { from } = buildDom()
    flyToTab(from, 't1')
    // 首个 animate 调用即幽灵飞行：中心 (107,207) → (48,16)，scale 16/14
    const last = animateCalls[0].keyframes as { transform: string }[]
    expect(last[last.length - 1].transform).toContain('translate(-59px, -191px)')
    expect(last[last.length - 1].transform).toContain('scale(1.1428571428571428)')
  })

  it('动画结束后移除幽灵并让目标图标微弹', async () => {
    const { from, tab } = buildDom()
    flyToTab(from, 't1')
    expect(document.querySelector('.flying-icon')).toBeTruthy()
    await Promise.resolve()
    expect(document.querySelector('.flying-icon')).toBeNull()
    expect(animateCalls.some((c) => c.el === tab.querySelector('.tab-icon'))).toBe(true)
  })

  // 降级：不支持 WAAPI 的内核不留残影
  it('环境无 Element.animate 时不产生幽灵', () => {
    unsetAnimate()
    const { from } = buildDom()
    flyToTab(from, 't1')
    expect(document.querySelector('.flying-icon')).toBeNull()
  })

  it('目标标签不存在时不产生幽灵', () => {
    const { from } = buildDom()
    flyToTab(from, 'missing-tab')
    expect(document.querySelector('.flying-icon')).toBeNull()
  })

  it('源元素尺寸为 0 时不飞行（避免除零与残影）', () => {
    const { from } = buildDom()
    setRect(from, { left: 0, top: 0, width: 0, height: 0 })
    flyToTab(from, 't1')
    expect(document.querySelector('.flying-icon')).toBeNull()
  })

  it('prefers-reduced-motion 时完全跳过', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const { from } = buildDom()
    flyToTab(from, 't1')
    expect(document.querySelector('.flying-icon')).toBeNull()
  })

  it('null 源元素安全返回', () => {
    buildDom()
    expect(() => flyToTab(null, 't1')).not.toThrow()
    expect(document.querySelector('.flying-icon')).toBeNull()
  })
})
