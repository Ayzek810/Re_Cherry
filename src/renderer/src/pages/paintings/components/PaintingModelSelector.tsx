/**
 * 绘画模型选择器（v0.3.3 批次4，V2 PaintingModelSelector 重写）：
 * 优先用 fork 既有 SelectChatModelPopup 薄封装——filter 谓词用
 * paintingModelSelection 的 supportsPaintingEdit/selectImageGenerationModels
 * 组合消化（feature 不直接 import config/models）。弹窗返回 Model，本组件
 * 只负责触发与回显，选中上抛 { providerId, modelId }。
 */
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup/chat-model-popup'
// fork 缝：本地同名谓词并入 paintingModelSelection.isPaintingCandidateModel（单一来源，
// 与「设置 › 默认模型 › 绘画模型」同一判定）。
import { isPaintingCandidateModel } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
// fork 缝：原 `import { Button } from 'antd'` —— SelectorButton 换成 styled.button 后不再使用。
import { ChevronDown } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export interface PaintingModelSelection {
  providerId: string
  modelId: string
}

interface PaintingModelSelectorProps {
  /** 当前选中模型（redux s.llm.paintingModel）。 */
  model: Model | undefined
  onSelect: (selection: PaintingModelSelection) => void
  disabled?: boolean
}

const PaintingModelSelector: FC<PaintingModelSelectorProps> = ({ model, onSelect, disabled }) => {
  const { t } = useTranslation()
  const providers = useAppSelector((state) => state.llm.providers)

  const openSelector = useCallback(async () => {
    const selected = await SelectChatModelPopup.show({
      model,
      // fork 缝：谓词改用 paintingModelSelection 的单一来源导出。
      filter: isPaintingCandidateModel
    })
    if (selected) {
      onSelect({ providerId: selected.provider, modelId: selected.id })
    }
  }, [model, onSelect])

  const providerName = model ? providers.find((provider) => provider.id === model.provider)?.name : undefined

  return (
    // fork 缝：styled(Button) → styled.button（见下方定义）。antd Button 默认渲染
    // <button type="button">，原生 button 在 form 内默认 type="submit"，故显式补 type="button"。
    <SelectorButton type="button" onClick={() => void openSelector()} disabled={disabled}>
      {model ? (
        <>
          <ModelAvatar model={model} size={20} />
          <ModelName>{model.name}</ModelName>
          {providerName && <ProviderName>{providerName}</ProviderName>}
        </>
      ) : (
        <ModelName>{t('paintings.select_model')}</ModelName>
      )}
      <ChevronDown size={14} />
    </SelectorButton>
  )
}

// fork 缝：V2 对应件是原生 button（@cherrystudio/ui Button，只吃 className），fork 曾用 antd Button，
// 其 .ant-btn 自带 display:inline-block/height/padding（CSS-in-JS 注入晚于 Tailwind 层）→ 顶掉 V2 的
// COMPOSER_SELECTOR_BUTTON_CLASS 尺寸类。改 styled.button；样式对象逐字不变（display:flex 本就覆盖
// 了 antd 的 inline-block，故无需补 display）。
const SelectorButton = styled.button`
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
`

const ModelName = styled.span`
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ProviderName = styled.span`
  color: var(--color-text-3);
  font-size: 12px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export default PaintingModelSelector
