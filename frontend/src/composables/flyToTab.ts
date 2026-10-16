// flyToTab：把点击的节点图标"飞"进新建标签的图标位，给出"这个标签由此而来"的因果反馈。
// 做法是 FLIP 的最小实现：克隆源图标为 fixed 定位的幽灵，用 Web Animations API
// 从源矩形位移+缩放到目标矩形，动画结束即移除。只依赖视口矩形，
// 因此标签栏横向滚动、标签数量变化都不影响正确性。

// 飞行时长与缓动：短到不打断操作节奏，长到能被眼睛追踪
const FLY_DURATION_MS = 260
const FLY_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
// 中途抬升量，让轨迹是弧线而非直线
const FLY_ARC_LIFT_PX = 10

const GHOST_BASE_STYLE = 'position:fixed;z-index:3000;pointer-events:none;margin:0;'

/** prefers-reduced-motion 下不做飞行（与 main.css 的无障碍降级策略一致） */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * flyToTab 让 from 元素飞入 tabId 对应标签的图标位置。
 * 目标缺失、源尺寸非法、或环境不支持 WAAPI 时静默返回（动画是增强，不是功能）。
 */
export function flyToTab(from: Element | null, tabId: string): void {
  if (!from || !tabId || prefersReducedMotion()) return

  const target = document
    .querySelector(`.tab[data-tab-id="${tabId}"]`)
    ?.querySelector('.tab-icon')
  if (!target) return

  // 新标签可能在标签栏可视区之外，先滚动到可见再取矩形，避免飞向看不见的地方
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })

  const start = from.getBoundingClientRect()
  const end = target.getBoundingClientRect()
  if (start.width <= 0 || start.height <= 0) return

  const ghost = from.cloneNode(true) as HTMLElement
  ghost.removeAttribute('id')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.classList.add('flying-icon')
  // 幽灵已脱离原父级，组件内 scoped 规则（如 .node-actions svg{fill}）不再命中，
  // 故把源元素算好的颜色与尺寸固化为内联样式。
  const fromStyle = window.getComputedStyle(from)
  ghost.style.cssText =
    `${GHOST_BASE_STYLE}left:${start.left}px;top:${start.top}px;` +
    `width:${start.width}px;height:${start.height}px;` +
    `fill:${fromStyle.fill};color:${fromStyle.color};`
  document.body.appendChild(ghost)

  // 不支持 WAAPI 的旧内核：直接放弃动画，不留残影
  if (typeof ghost.animate !== 'function') {
    ghost.remove()
    return
  }

  const dx = end.left + end.width / 2 - (start.left + start.width / 2)
  const dy = end.top + end.height / 2 - (start.top + start.height / 2)
  const scale = end.width / start.width
  const midScale = (1 + scale) / 2

  const flight = ghost.animate(
    [
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1, offset: 0 },
      {
        transform: `translate(${dx * 0.5}px, ${dy * 0.5 - FLY_ARC_LIFT_PX}px) scale(${midScale})`,
        opacity: 0.9,
        offset: 0.6,
      },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.85, offset: 1 },
    ],
    { duration: FLY_DURATION_MS, easing: FLY_EASING, fill: 'forwards' },
  )
  flight.onfinish = () => {
    ghost.remove()
    landOn(target)
  }
  flight.oncancel = () => ghost.remove()
}

/** landOn 落点微弹：图标到位后轻弹一下，收束飞行的动量 */
function landOn(target: Element): void {
  if (typeof (target as HTMLElement).animate !== 'function') return
  ;(target as HTMLElement).animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.18)' },
      { transform: 'scale(1)' },
    ],
    { duration: 160, easing: 'ease-out' },
  )
}
