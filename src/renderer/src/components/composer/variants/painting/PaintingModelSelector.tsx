// fork 缝：V2 `pages/paintings/components/PaintingModelSelector.tsx` 的作曲条侧替身。
// V2 的签名是 `{ hideTitle, painting, onSelect, className }`（组件内部解析模型 + 弹窗）；
// fork 原件的签名是 `{ model, onSelect, disabled }`（props 驱动、无 className），故在此
// 缝里做参数适配，不改 fork 原件：模型从画作解析，className 落在包裹层。
import PaintingModelSelectorView, {
  type PaintingModelSelection
} from '@renderer/pages/paintings/components/PaintingModelSelector'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
import { useMemo } from 'react'

interface PaintingModelSelectorProps {
  /** V2 标志：工具栏里不重复标题（V2 作曲条就这么传，fork 照旧不显示标题）。 */
  hideTitle?: boolean
  /** V2 `renderContextControls` 的图标态（v0.3.3-7 接上）：窄窗时只留头像 + 箭头。 */
  iconOnly?: boolean
  painting: PaintingData
  onSelect: (selection: PaintingModelSelection) => void
  className?: string
}

const PaintingModelSelector = ({ painting, onSelect, className, iconOnly }: PaintingModelSelectorProps) => {
  const providers = useAppSelector((state) => state.llm.providers)
  const model = useMemo<Model | undefined>(
    () =>
      providers
        .find((provider) => provider.id === painting.providerId)
        ?.models.find((candidate) => candidate.id === painting.model),
    [painting.model, painting.providerId, providers]
  )

  // V2 原样：作曲条里只有模型控件本身，不自造标题（用户裁决：不要在这里加「绘画模型」标签，
  // 那个标签属于模型设置里的能力标注）。
  return (
    <span className={className}>
      <PaintingModelSelectorView model={model} onSelect={onSelect} iconOnly={iconOnly} />
    </span>
  )
}

export default PaintingModelSelector
