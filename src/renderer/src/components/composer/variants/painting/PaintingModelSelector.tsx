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
  /** V2 标志：工具栏里不重复标题（fork 原件本就无标题，接受并忽略）。 */
  hideTitle?: boolean
  painting: PaintingData
  onSelect: (selection: PaintingModelSelection) => void
  className?: string
}

const PaintingModelSelector = ({ painting, onSelect, className }: PaintingModelSelectorProps) => {
  const providers = useAppSelector((state) => state.llm.providers)
  const model = useMemo<Model | undefined>(
    () =>
      providers
        .find((provider) => provider.id === painting.providerId)
        ?.models.find((candidate) => candidate.id === painting.model),
    [painting.model, painting.providerId, providers]
  )

  return (
    <span className={className}>
      <PaintingModelSelectorView model={model} onSelect={onSelect} />
    </span>
  )
}

export default PaintingModelSelector
