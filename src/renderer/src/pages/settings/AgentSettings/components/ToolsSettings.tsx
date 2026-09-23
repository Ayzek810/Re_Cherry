import type { Assistant } from '@renderer/types'
import { BUILTIN_TOOL_IDS, EXTERNAL_TOOL_IDS } from '@shared/config/agentTools'
import { Switch } from 'antd'
import type { FC } from 'react'
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
        {/* fork 缝：绘画模型选择器不在此处——已移到「设置 › 默认模型 › 绘画模型」
            （ModelSettings.tsx，llm.paintingModel 单一编辑点），本页只留工具面开关。 */}
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
