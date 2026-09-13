import AgentSettingsPopup from '@renderer/pages/settings/AgentSettings/AgentSettingsPopup'
import type { Assistant } from '@renderer/types'

interface AssistantSettingPopupShowParams {
  assistant: Assistant
  tab?: AssistantSettingPopupTab
}

type AssistantSettingPopupTab = 'prompt' | 'model' | 'messages' | 'mcp' | 'regular_phrases' | 'memory'

/**
 * 兼容入口：保留原 `static show({ assistant, tab? })` 签名（AssistantItem / TopicContent / Prompt
 * 三个调用点不改），内部委托 AgentSettingsPopup。
 * v0.3.0 验收调整：提示词栏目并入基础页，旧 tab 键（含点开空白的 'mcp'）一律映射 'essential'。
 * 记忆 / 常用语 / 采样模型等旧面板组件保留在本目录，待后续版本归位。
 */
export default class AssistantSettingsPopup {
  static show(props: AssistantSettingPopupShowParams): Promise<Assistant> {
    return AgentSettingsPopup.show({ assistant: props.assistant, tab: 'essential' })
  }
}
