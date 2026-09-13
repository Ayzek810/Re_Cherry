import { TopView } from '@renderer/components/TopView'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useAssistantPreset } from '@renderer/hooks/useAssistantPresets'
import type { Assistant, AssistantPreset, AssistantSettings } from '@renderer/types'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseSettingsPopup, type SettingsMenuItem, type SettingsPopupTab } from './BaseSettingsPopup'
import AdvancedSettings from './components/AdvancedSettings'
import EssentialSettings from './components/EssentialSettings'
import PermissionModeSettings from './components/PermissionModeSettings'
import SkillsSettings from './components/SkillsSettings'
import ToolsSettings from './components/ToolsSettings'
import { AgentLabel } from './shared'

interface AgentSettingsPopupShowParams {
  assistant: Assistant
  tab?: SettingsPopupTab
}

interface AgentSettingsPopupParams extends AgentSettingsPopupShowParams {
  resolve: (assistant: Assistant) => void
}

/**
 * 智能体设置弹窗（V1 结构移植；数据实体为 Redux 的 Assistant）。
 * v0.3.0 验收调整：提示词栏目并入基础页，现为五页（基础/权限模式/工具/技能/高级）。
 * 保留旧助手设置弹窗的双实体路径：type === 'agent' 时走助手预设（useAssistantPreset）。
 */
const AgentSettingsPopupContainer: React.FC<AgentSettingsPopupParams> = ({
  tab,
  assistant: propsAssistant,
  resolve
}) => {
  const { t } = useTranslation()
  const _useAssistant = useAssistant(propsAssistant.id)
  const _usePreset = useAssistantPreset(propsAssistant.id)
  const isAgent = propsAssistant.type === 'agent'

  const assistant = isAgent ? (_usePreset.preset ?? propsAssistant) : _useAssistant.assistant

  const updateAssistant = (update: Partial<Omit<Assistant, 'id'>>) => {
    if (isAgent && _usePreset.preset) {
      _usePreset.updateAssistantPreset({ ..._usePreset.preset, ...update } as AssistantPreset)
    } else {
      _useAssistant.updateAssistant(update)
    }
  }

  const updateAssistantSettings = (settings: Partial<AssistantSettings>) => {
    if (isAgent) {
      _usePreset.updateAssistantPresetSettings(settings)
    } else {
      _useAssistant.updateAssistantSettings(settings)
    }
  }

  const menuItems: SettingsMenuItem[] = useMemo(
    () => [
      { key: 'essential', label: t('settings.agentSettings.essential') },
      { key: 'permission-mode', label: t('settings.agentSettings.permissionMode.tab') },
      { key: 'tools', label: t('settings.agentSettings.tools.tab') },
      { key: 'skills', label: t('settings.agentSettings.skills.tab') },
      { key: 'advanced', label: t('settings.agentSettings.advance.tab') }
    ],
    [t]
  )

  const renderTabContent = (currentTab: SettingsPopupTab) => {
    if (!assistant) return null

    switch (currentTab) {
      case 'essential':
        return (
          <EssentialSettings
            assistant={assistant}
            updateAssistant={updateAssistant}
            updateAssistantSettings={updateAssistantSettings}
          />
        )
      case 'permission-mode':
        return <PermissionModeSettings assistant={assistant} updateAssistant={updateAssistant} />
      case 'tools':
        return <ToolsSettings assistant={assistant} updateAssistant={updateAssistant} />
      case 'skills':
        return <SkillsSettings />
      case 'advanced':
        return <AdvancedSettings />
      default:
        return null
    }
  }

  return (
    <BaseSettingsPopup
      initialTab={tab}
      onClose={() => resolve(assistant)}
      titleContent={<AgentLabel assistant={assistant} />}
      menuItems={menuItems}
      renderTabContent={renderTabContent}
    />
  )
}

export default class AgentSettingsPopup {
  static show(props: AgentSettingsPopupShowParams): Promise<Assistant> {
    return new Promise<Assistant>((resolve) => {
      TopView.show(
        <AgentSettingsPopupContainer
          {...props}
          resolve={(assistant) => {
            resolve(assistant)
            TopView.hide('AgentSettingsPopup')
          }}
        />,
        'AgentSettingsPopup'
      )
    })
  }
}
