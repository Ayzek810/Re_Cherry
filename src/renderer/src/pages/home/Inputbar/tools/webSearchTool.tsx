import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import WebSearchButton from './components/WebSearchButton'
import WebSearchQuickPanelManager from './components/WebSearchQuickPanelManager'

/**
 * Web Search Tool（v0.3.2 自 CS_V1 移植）
 *
 * Allows users to enable web search for their messages.
 * Supports both model built-in search and external search providers.
 * 批次1 仅为 UI 开关（写 assistant.webSearchProviderId / enableWebSearch）；
 * 搜索执行批次2 接线。V1 的 isMandatoryWebSearchModel 条件随机制批次恢复。
 */
const webSearchTool = defineTool({
  key: 'web_search',
  label: (t) => t('chat.input.web_search.label'),

  visibleInScopes: [TopicType.Chat],

  render: function WebSearchToolRender(context) {
    const { assistant, quickPanelController } = context

    return <WebSearchButton quickPanelController={quickPanelController} assistantId={assistant.id} />
  },
  quickPanelManager: WebSearchQuickPanelManager
})

registerTool(webSearchTool)

export default webSearchTool
