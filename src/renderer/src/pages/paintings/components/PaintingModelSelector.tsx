/**
 * 绘画模型选择器（v0.3.3 批次4，V2 PaintingModelSelector 重写）：
 * 优先用 fork 既有 SelectChatModelPopup 薄封装——filter 谓词用
 * paintingModelSelection 的 supportsPaintingEdit/selectImageGenerationModels
 * 组合消化（feature 不直接 import config/models）。弹窗返回 Model，本组件
 * 只负责触发与回显，选中上抛 { providerId, modelId }。
 */
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup/chat-model-popup'
import { selectImageGenerationModels } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Model, Provider } from '@renderer/types'
import { Button } from 'antd'
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

/** 生图模型弹窗过滤谓词：经 paintingModelSelection 消化（对话式 + 专用生图）。 */
const isPaintingCandidate = (model: Model): boolean => {
  return selectImageGenerationModels([{ id: model.provider, models: [model], enabled: true } as Provider]).length > 0
}

const PaintingModelSelector: FC<PaintingModelSelectorProps> = ({ model, onSelect, disabled }) => {
  const { t } = useTranslation()
  const providers = useAppSelector((state) => state.llm.providers)

  const openSelector = useCallback(async () => {
    const selected = await SelectChatModelPopup.show({
      model,
      filter: isPaintingCandidate
    })
    if (selected) {
      onSelect({ providerId: selected.provider, modelId: selected.id })
    }
  }, [model, onSelect])

  const providerName = model ? providers.find((provider) => provider.id === model.provider)?.name : undefined

  return (
    <SelectorButton onClick={() => void openSelector()} disabled={disabled}>
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

const SelectorButton = styled(Button)`
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
