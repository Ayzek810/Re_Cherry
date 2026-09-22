/**
 * v0.3.2 自 CS_V1 utils/mcp-tools.ts 移植（批次1 MCPSettings 页面依赖）。
 * fork 改动点：暂不移植 callMCPTool——它依赖主进程 window.api.mcp.callTool 通道
 * （批次3 接线）；callBuiltInTool / getMcpServerByTool / isToolAutoApproved 为纯逻辑，原样保留。
 */
import { loggerService } from '@logger'
import store from '@renderer/store'
import { hubMCPServer } from '@renderer/store/mcp'
import type { MCPCallToolResponse, MCPServer, MCPTool, MCPToolResponse } from '@renderer/types'

const logger = loggerService.withContext('Utils:MCPTools')

export async function callBuiltInTool(toolResponse: MCPToolResponse): Promise<MCPCallToolResponse | undefined> {
  logger.info(`[BuiltIn] Calling Built-in Tool: ${toolResponse.tool.name}`, toolResponse.tool)

  if (
    toolResponse.tool.name === 'think' &&
    typeof toolResponse.arguments === 'object' &&
    toolResponse.arguments !== null &&
    !Array.isArray(toolResponse.arguments)
  ) {
    const thought = toolResponse.arguments?.thought
    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: (thought as string) || ''
        }
      ]
    }
  }

  return undefined
}

export function getMcpServerByTool(tool: MCPTool) {
  const servers = store.getState().mcp.servers
  const server = servers.find((s) => s.id === tool.serverId)
  if (server) {
    return server
  }
  // For hub server (auto mode), the server isn't in the store
  // Return the hub server constant if the tool's serverId matches
  if (tool.serverId === 'hub') {
    return hubMCPServer
  }
  return undefined
}

export function isToolAutoApproved(tool: MCPTool, server?: MCPServer, allowedTools?: string[]): boolean {
  if (tool.isBuiltIn) {
    return true
  }
  // Check agent-level pre-authorization (allowed_tools from Agent Settings)
  if (allowedTools?.includes(tool.id)) {
    return true
  }
  // Fall back to server-level auto-approve setting
  const effectiveServer = server ?? getMcpServerByTool(tool)
  if (!effectiveServer) return false
  // Hub meta-tools: read-only tools (list, inspect) are auto-approved;
  // execution tools (invoke, exec) require approval.
  if (effectiveServer.id === 'hub') {
    return tool.name === 'list' || tool.name === 'inspect'
  }
  return !effectiveServer.disabledAutoApproveTools?.includes(tool.name)
}
