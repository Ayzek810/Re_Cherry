// fork 缝：V2 `variants/shared/ComposerControlScaffolding.tsx:8-9` 的 class 常量 +
// `ComposerToolbarControls`。V2 的工具栏控件会在上下文控件前后插入
// `ComposerActiveToolControls` + `ComposerToolMenu`（工具注册表，fork 无），
// 故此处只保留"上下文控件进工具栏左半"的骨架。
import { cn } from '@renderer/utils/style'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** V2:8 `COMPOSER_TOOLBAR_CLASS`，逐字。 */
export const COMPOSER_TOOLBAR_CLASS = 'flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden'
/** V2:9 `COMPOSER_SELECTOR_BUTTON_CLASS`，逐字。 */
export const COMPOSER_SELECTOR_BUTTON_CLASS = 'h-7 shrink-0 gap-1.5 rounded-full px-2 text-xs'
/** V2:14 `COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS`，逐字（图标态：只留图标、宽度收到 32px）。 */
export const COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS = 'w-8 justify-center px-0'
/** V2:15 `COMPOSER_ICON_ONLY_LABEL_CLASS`，逐字（图标态：文字转屏读专用）。 */
export const COMPOSER_ICON_ONLY_LABEL_CLASS = 'sr-only'

/** V2 `useOverflowIconOnly.ts:3` 的回滞阈值（释放宽度缓冲，防止边界抖动反复切换）。 */
const OVERFLOW_RELEASE_WIDTH_BUFFER = 24

type RenderContextControls = (args: { side: 'top' | 'bottom'; iconOnly: boolean }) => ReactNode

/**
 * fork 缝：V2 `hooks/useOverflowIconOnly.ts` 的溢出检测（P1：fork 此前 `iconOnly` 恒 false）。
 * 语义与 V2 一致：`scrollWidth > clientWidth` 判定溢出 → 进图标态；并在"释放缓冲"内
 * （`clientWidth <= 激活宽度 + 24`）保持图标态，避免在临界宽度来回闪。
 * fork 的差异只有两处，均不影响判据：① 容器用 callback ref（V2 用 `useState` 存节点）；
 * ② 只 observe 容器自身（V2 额外 observe 每个子节点 + MutationObserver 盯子节点增删）——
 * 工具栏内容由 variant 的 render 回调驱动、每次 render 都重测，子节点变化会被下一帧量到。
 */
const useOverflowIconOnly = () => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [iconOnly, setIconOnly] = useState(false)
  const iconOnlyRef = useRef(false)
  const activationWidthRef = useRef<number | null>(null)

  const containerRef = useCallback((node: HTMLDivElement | null) => setContainer(node), [])

  const update = useCallback(
    (measuredWidth?: number) => {
      if (!container) return

      const clientWidth = container.clientWidth || measuredWidth || container.getBoundingClientRect().width
      if (clientWidth <= 0) return

      const scrollWidth = container.scrollWidth || clientWidth
      const currentIconOnly = iconOnlyRef.current
      const hasOverflow = scrollWidth > clientWidth + 1

      if (!currentIconOnly && hasOverflow) {
        activationWidthRef.current = clientWidth
      }

      const activationWidth = activationWidthRef.current
      const nextIconOnly =
        hasOverflow ||
        (currentIconOnly && activationWidth !== null && clientWidth <= activationWidth + OVERFLOW_RELEASE_WIDTH_BUFFER)

      if (!nextIconOnly) activationWidthRef.current = null
      if (currentIconOnly === nextIconOnly) return

      iconOnlyRef.current = nextIconOnly
      setIconOnly(nextIconOnly)
    },
    [container]
  )

  // 每次 render 后重测（内容宽度随 variant 状态变化时，容器尺寸不一定变）。
  useLayoutEffect(() => {
    update()
  }, [update])

  useEffect(() => {
    if (!container) return
    update()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === container)
      // 量两次：第一次按内容矩形，第二次在图标态切换后按即时布局收口（临界宽度不残留）。
      update(entry?.contentRect.width)
      update()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container, update])

  return { iconOnly, containerRef }
}

/** V2:38-81 `ComposerToolbarControls`；工具菜单位（`showToolMenu`/`toolMenuPlacement`）省去。 */
export const ComposerToolbarControls = ({
  renderContextControls,
  leading
}: {
  renderContextControls: RenderContextControls
  leading?: ReactNode
  /** V2 把这两个句柄交给 `ComposerToolMenu`（`/` 面板入口）；fork 无工具注册表，故有意忽略。
   *  后果：工具栏本身没有 `/` 菜单按钮——fork 的 `/` 面板入口在作曲条 textarea 的输入触发
   *  （`ComposerSurface.maybeOpenPhrasePanel`），不经过本组件。 */
  inputAdapter?: unknown
  unifiedPanelControl?: unknown
}) => {
  const { iconOnly, containerRef } = useOverflowIconOnly()
  const contextControls = renderContextControls({ side: 'top', iconOnly })

  return (
    <div ref={containerRef} className={cn(COMPOSER_TOOLBAR_CLASS, 'w-full')}>
      {leading}
      {contextControls}
    </div>
  )
}
