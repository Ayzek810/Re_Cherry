import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup/chat-model-popup'
import { selectImageGenerationModels } from '@renderer/services/paintingModelSelection'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setPaintingModel } from '@renderer/store/llm'
import type { Assistant, Model, Provider } from '@renderer/types'
import { BUILTIN_TOOL_IDS, EXTERNAL_TOOL_IDS } from '@shared/config/agentTools'
import { Button, Switch } from 'antd'
import { ChevronDown } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingsContainer, SettingsItem, SettingsTitle } from '../shared'

interface Props {
  assistant: Assistant
  updateAssistant: (update: Partial<Omit<Assistant, 'id'>>) => void
}

/** 静态 i18n 键映射（注册表 id → 词条键；显式写出以通过 i18n 动态键检查）。 */
const BUILTIN_TOOL_I18N: Record<string, string> = {
  ask_user_question: 'settings.agentSettings.tools.builtins.ask.name',
  ocr_document: 'settings.agentSettings.tools.builtins.ocr.name'
}

const EXTERNAL_TOOL_I18N: Record<string, string> = {
  fs: 'settings.agentSettings.tools.externals.fs.name',
  fsSearch: 'settings.agentSettings.tools.externals.fsSearch.name',
  editor: 'settings.agentSettings.tools.externals.editor.name',
  pwsh: 'settings.agentSettings.tools.externals.pwsh.name',
  jobs: 'settings.agentSettings.tools.externals.jobs.name'
}

/**
 * 工具页（v0.3.0 验收设计）：方形卡片网格，两组工具各带开关（稀疏 map 缺省 = 开，默认全开），
 * 拨动下一轮对话生效。内置工具（@shared/config/agentTools）未开启工作模式也可用；
 * 外置工具仅工作模式开启时挂载；审批三档在「权限模式」页（单一数据源单一编辑点）。
 */
const ToolsSettings: FC<Props> = ({ assistant, updateAssistant }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const paintingModel = useAppSelector((state) => state.llm.paintingModel)

  /** 生图候选谓词与绘画页选择器同源（paintingModelSelection 消化后的二值判定）。 */
  const isPaintingCandidate = (model: Model): boolean =>
    selectImageGenerationModels([{ id: model.provider, models: [model], enabled: true } as Provider]).length > 0

  const openPaintingModelPicker = useCallback(async () => {
    const selected = await SelectChatModelPopup.show({ model: paintingModel, filter: isPaintingCandidate })
    if (selected) {
      dispatch(setPaintingModel({ model: selected }))
    }
    // paintingModel 变化会重渲染，无需本地态
  }, [dispatch, paintingModel])

  const isEnabled = (map: Record<string, boolean> | undefined, toolId: string): boolean => map?.[toolId] !== false

  const handleToggle = (field: 'builtinTools' | 'externalTools', toolId: string, enabled: boolean) => {
    updateAssistant({ [field]: { ...assistant[field], [toolId]: enabled } })
  }

  const renderToolGrid = (
    field: 'builtinTools' | 'externalTools',
    entries: readonly string[],
    i18nMap: Record<string, string>
  ) => (
    <ToolGrid>
      {entries.map((toolId) => (
        <ToolCard key={toolId} onClick={() => handleToggle(field, toolId, !isEnabled(assistant[field], toolId))}>
          <span className="truncate text-left text-sm">{t(i18nMap[toolId])}</span>
          <Switch
            size="small"
            checked={isEnabled(assistant[field], toolId)}
            onClick={(_, event) => event.stopPropagation()}
            onChange={(enabled) => handleToggle(field, toolId, enabled)}
          />
        </ToolCard>
      ))}
    </ToolGrid>
  )

  return (
    <SettingsContainer>
      <SettingsItem divider={false}>
        <SettingsTitle>{t('settings.agentSettings.tools.builtinTitle')}</SettingsTitle>
        {renderToolGrid('builtinTools', BUILTIN_TOOL_IDS, BUILTIN_TOOL_I18N)}
        {/* 批次5 双门：assistant.enableGenerateImage（工具面）+ llm.paintingModel（模型面）。
            模型面在**设置页**配置（V2 的 feature.paintings.default_model_id 语义），绘画页只读它
            播种新草稿、不再写全局值。 */}
        <ToolGrid>
          <ToolCard onClick={() => updateAssistant({ enableGenerateImage: !assistant.enableGenerateImage })}>
            <span className="truncate text-left text-sm">{t('settings.agentSettings.tools.builtins.generate_image.name')}</span>
            <Switch
              size="small"
              checked={assistant.enableGenerateImage === true}
              onClick={(_, event) => event.stopPropagation()}
              onChange={(enabled) => updateAssistant({ enableGenerateImage: enabled })}
            />
          </ToolCard>
        </ToolGrid>
        <PickerRow>
          <span className="text-sm">{t('paintings.model')}</span>
          <Button onClick={() => void openPaintingModelPicker()}>
            {paintingModel ? (
              <>
                <ModelAvatar model={paintingModel} size={20} />
                <PickerName>{paintingModel.name}</PickerName>
              </>
            ) : (
              <PickerName>{t('paintings.select_model')}</PickerName>
            )}
            <ChevronDown size={14} />
          </Button>
        </PickerRow>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          {t('settings.agentSettings.tools.builtins.generate_image.hint')}
        </span>
      </SettingsItem>

      <SettingsItem divider={false}>
        <SettingsTitle>{t('settings.agentSettings.tools.externalTitle')}</SettingsTitle>
        {renderToolGrid('externalTools', EXTERNAL_TOOL_IDS, EXTERNAL_TOOL_I18N)}
      </SettingsItem>

      <SettingsItem divider={false}>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          {t('settings.agentSettings.tools.placeholder')}
        </span>
      </SettingsItem>
    </SettingsContainer>
  )
}

/** 方形卡片网格（照 dnd/Sortable 的 grid 布局习惯：auto-fill + minmax）。 */
const ToolGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  width: 100%;
`

const PickerRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  margin-top: 8px;

  .ant-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
  }
`

const PickerName = styled.span`
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ToolCard = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 56px;
  padding: 10px 12px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s;

  &:hover {
    border-color: var(--color-primary);
  }
`

export default ToolsSettings
