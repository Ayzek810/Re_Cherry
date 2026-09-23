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
import { useTranslation } from 'react-i18next'

interface PaintingModelSelectorProps {
  /** V2 标志：工具栏里不重复标题。fork 缝有意忽略它——用户要求显式「绘画模型」标签（见下方 fork 缝注释）。 */
  hideTitle?: boolean
  painting: PaintingData
  onSelect: (selection: PaintingModelSelection) => void
  className?: string
}

const PaintingModelSelector = ({ painting, onSelect, className }: PaintingModelSelectorProps) => {
  const { t } = useTranslation()
  const providers = useAppSelector((state) => state.llm.providers)
  const model = useMemo<Model | undefined>(
    () =>
      providers
        .find((provider) => provider.id === painting.providerId)
        ?.models.find((candidate) => candidate.id === painting.model),
    [painting.model, painting.providerId, providers]
  )

  // fork 缝：用户要求显式「绘画模型」标签；V2 在作曲条传 hideTitle 刻意隐藏，这里有意偏离（去掉本行即回 V2 原样）。
  // 文案复用 fork 既有键 settings.models.painting_model（绘画模型 / Painting Model），不新增 locale 键；
  // 标签放在模型按钮之前且 shrink-0，不吃模型按钮自身的宽度上限（className 包裹层保持原样）。
  return (
    <span className="flex items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground text-xs">{t('settings.models.painting_model')}</span>
      <span className={className}>
        <PaintingModelSelectorView model={model} onSelect={onSelect} />
      </span>
    </span>
  )
}

export default PaintingModelSelector
