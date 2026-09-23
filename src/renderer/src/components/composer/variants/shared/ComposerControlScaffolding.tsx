// fork 缝：V2 `variants/shared/ComposerControlScaffolding.tsx:8-9` 的 class 常量 +
// `ComposerToolbarControls`。V2 的工具栏控件会在上下文控件前后插入
// `ComposerActiveToolControls` + `ComposerToolMenu`（工具注册表，fork 无），
// 故此处只保留"上下文控件进工具栏左半"的骨架。
import { cn } from '@renderer/utils/style'
import type { ReactNode } from 'react'

/** V2:8 `COMPOSER_TOOLBAR_CLASS`，逐字。 */
export const COMPOSER_TOOLBAR_CLASS = 'flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden'
/** V2:9 `COMPOSER_SELECTOR_BUTTON_CLASS`，逐字。 */
export const COMPOSER_SELECTOR_BUTTON_CLASS = 'h-7 shrink-0 gap-1.5 rounded-full px-2 text-xs'

type RenderContextControls = (args: { side: 'top' | 'bottom'; iconOnly: boolean }) => ReactNode

/** V2:38-81 `ComposerToolbarControls`；工具菜单位（`showToolMenu`/`toolMenuPlacement`）省去。 */
export const ComposerToolbarControls = ({
  renderContextControls,
  leading
}: {
  renderContextControls: RenderContextControls
  leading?: ReactNode
  /** V2 传给共享工具控件的两个句柄；fork 无工具注册表，接受并忽略。 */
  inputAdapter?: unknown
  unifiedPanelControl?: unknown
}) => {
  // V2 用 `useOverflowIconOnly` 量宽度决定图标态；fork 无该 hook，恒全宽（iconOnly 恒 false）。
  const contextControls = renderContextControls({ side: 'top', iconOnly: false })

  return (
    <div className={cn(COMPOSER_TOOLBAR_CLASS, 'w-full')}>
      {leading}
      {contextControls}
    </div>
  )
}
