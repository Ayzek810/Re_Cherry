import { TopView } from '@renderer/components/TopView'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { Assistant, AssistantSettings } from '@renderer/types'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseSettingsPopup, type SettingsMenuItem, type SettingsPopupTab } from './BaseSettingsPopup'
import AdvancedSettings from './components/AdvancedSettings'
import EssentialSettings from './components/EssentialSettings'
import PermissionModeSettings from './components/PermissionModeSettings'
import SkillsSettings from './components/SkillsSettings'
import ToolsSettings from './components/ToolsSettings'
import { AgentLabel } from './shared'

const TOP_VIEW_KEY = 'AgentSettingsPopup'

interface AgentSettingsPopupShowParams {
  assistant: Assistant
  tab?: SettingsPopupTab
}

interface AgentSettingsShellProps {
  assistant: Assistant
  updateAssistant: (update: Partial<Omit<Assistant, 'id'>>) => void
  updateAssistantSettings: (settings: Partial<AssistantSettings>) => void
  tab?: SettingsPopupTab
  /** confirmed：按「确认」关闭为 true，X / Esc / 点遮罩为 false */
  onClose: (confirmed: boolean) => void
}

/**
 * 智能体设置弹窗（V1 结构移植）。v0.3.0 验收调整：提示词栏目并入基础页，现为五页
 * （基础/权限模式/工具/技能/高级）。
 *
 * 五页全是 props 驱动（不自己读 Redux），所以**数据来源由外层容器决定**：
 * - 编辑既有助手 → Redux 实体（`EditAssistantSettingsContainer`）；
 * - 「添加助手」新建 → 本地草稿（`DraftAssistantSettingsContainer`），确认前不落库、不碰模板。
 *
 * v0.3.1-2 沿革（两次返修，用户裁决）：预设系统整链移除后一度把「默认助手」当成本弹窗的
 * 可写实体（栏目改动即时写回模板）——用户否掉："你为什么要写回呢，默认条件下助手设置不应该是
 * 一个不可变的基本模板吗，不然它能叫默认吗"。现语义：默认助手是**只读模板**，要改模板请走
 * 设置 → 模型设置 → 默认助手。
 */
const AgentSettingsShell: React.FC<AgentSettingsShellProps> = ({
  assistant,
  updateAssistant,
  updateAssistantSettings,
  tab,
  onClose
}) => {
  const { t } = useTranslation()

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
      onClose={onClose}
      titleContent={<AgentLabel assistant={assistant} />}
      menuItems={menuItems}
      renderTabContent={renderTabContent}
    />
  )
}

interface EditAssistantSettingsProps {
  assistant: Assistant
  tab?: SettingsPopupTab
  resolve: (assistant: Assistant) => void
}

/** 编辑既有助手：实体是 Redux 里的 Assistant（助手右键「设置」、导航栏权限模式入口走这条）。 */
const EditAssistantSettingsContainer: React.FC<EditAssistantSettingsProps> = ({
  assistant: propsAssistant,
  tab,
  resolve
}) => {
  const _useAssistant = useAssistant(propsAssistant.id)

  return (
    <AgentSettingsShell
      assistant={_useAssistant.assistant}
      updateAssistant={_useAssistant.updateAssistant}
      updateAssistantSettings={_useAssistant.updateAssistantSettings}
      tab={tab}
      onClose={() => resolve(_useAssistant.assistant)}
    />
  )
}

interface DraftAssistantSettingsProps {
  assistant: Assistant
  tab?: SettingsPopupTab
  resolve: (draft: Assistant | null) => void
}

/** 按模板新建：实体是模板的本地草稿——弹窗里怎么改都不落库，「确认」交回草稿，
 *  X / Esc / 点遮罩交回 null（＝什么都不建）。模板（默认助手）本体自始至终不被写。 */
const DraftAssistantSettingsContainer: React.FC<DraftAssistantSettingsProps> = ({
  assistant: template,
  tab,
  resolve
}) => {
  const [draft, setDraft] = useState<Assistant>(template)

  const updateAssistant = (update: Partial<Omit<Assistant, 'id'>>) => {
    setDraft((current) => ({ ...current, ...update }))
  }

  const updateAssistantSettings = (settings: Partial<AssistantSettings>) => {
    setDraft((current) => ({ ...current, settings: { ...current.settings, ...settings } }))
  }

  return (
    <AgentSettingsShell
      assistant={draft}
      updateAssistant={updateAssistant}
      updateAssistantSettings={updateAssistantSettings}
      tab={tab}
      onClose={(confirmed) => resolve(confirmed ? draft : null)}
    />
  )
}

export default class AgentSettingsPopup {
  /** 编辑既有助手；关闭时回传该助手（内容已即时写回 Redux）。 */
  static show(props: AgentSettingsPopupShowParams): Promise<Assistant> {
    return new Promise<Assistant>((resolve) => {
      TopView.show(
        <EditAssistantSettingsContainer
          {...props}
          resolve={(assistant) => {
            resolve(assistant)
            TopView.hide(TOP_VIEW_KEY)
          }}
        />,
        TOP_VIEW_KEY
      )
    })
  }

  /** 按模板新建：确认回传草稿（调用方负责落库），取消回传 null。 */
  static showDraft(props: AgentSettingsPopupShowParams): Promise<Assistant | null> {
    return new Promise<Assistant | null>((resolve) => {
      TopView.show(
        <DraftAssistantSettingsContainer
          {...props}
          resolve={(draft) => {
            resolve(draft)
            TopView.hide(TOP_VIEW_KEY)
          }}
        />,
        TOP_VIEW_KEY
      )
    })
  }
}
