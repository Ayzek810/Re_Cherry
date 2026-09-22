import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import MCPToolsButton from './components/MCPToolsButton'

/**
 * MCP Tools Tool（v0.3.2 自 CS_V1 移植）
 * 批次1 仅为 UI 开关（写 assistant.mcpMode / mcpServers）；服务器进程与工具调用批次3 接线。
 * V1 的 Prompts/Resources 两个 QuickPanel 入口依赖 window.api.mcp.*（fork 暂无该通道），批次3 恢复。
 */
const mcpToolsTool = defineTool({
  key: 'mcp_tools',
  label: (t) => t('settings.mcp.title'),
  visibleInScopes: [TopicType.Chat],
  dependencies: {
    actions: ['onTextChange', 'resizeTextArea'] as const
  },
  render: ({ assistant, actions, quickPanel }) => (
    <MCPToolsButton
      assistantId={assistant.id}
      quickPanel={quickPanel}
      setInputValue={actions.onTextChange}
      resizeTextArea={actions.resizeTextArea}
    />
  )
})

registerTool(mcpToolsTool)

export default mcpToolsTool
