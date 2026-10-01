/**
 * MCP 主进程 API（接线：替身整体换装真实 IPC）。
 *
 * 真通道方法直通主进程 MCPService（preload window.api.mcp 薄转发）；纯配置类
 * updateServer 不经进程——服务器配置真相源是 redux mcp 切片（经 Dsh_SyncMcpServers
 * 整体投影进主进程内存），主进程不回写配置。：uploadDxt（DXT 扩展安装）接线，
 * 走 Mcp_UploadDxt → 主进程 DxtService。
 *
 * v1 清理：删掉 4 个 死桩（isBinaryExist 恒 false / getInstallInfo 恒 null /
 * installUVBinary / installBunBinary 只会 toast「待接线」）。它们让依赖页**永远显示
 * 「依赖缺失」**且安装键永不生效——失败伪装 + 孤儿代码。fork 的 MCP stdio 服务器
 * 靠系统 PATH 解析命令（npx/uvx，见 main/services/mcp/commandResolution.ts），
 * 不托管 uv/bun 二进制，故页面改用 checkCommand 如实探测。
 */
import { loggerService } from '@logger'
import type { MCPPrompt, MCPResource, MCPServer, MCPTool } from '@renderer/types'
import type { DxtUploadResult, MCPServerLogEntry } from '@shared/config/types'

const logger = loggerService.withContext('McpApi')

type ServerLogEntry = MCPServerLogEntry & { serverId?: string }

export const mcpApi = {
  listTools: (server: MCPServer): Promise<MCPTool[]> => window.api.mcp.listTools(server),
  listPrompts: (server: MCPServer): Promise<MCPPrompt[]> => window.api.mcp.listPrompts(server),
  listResources: (server: MCPServer): Promise<MCPResource[]> => window.api.mcp.listResources(server),
  getServerVersion: (server: MCPServer): Promise<string | null> => window.api.mcp.getServerVersion(server),
  getServerLogs: (server: MCPServer): Promise<ServerLogEntry[]> => window.api.mcp.getServerLogs(server),
  onServerLog: (callback: (log: ServerLogEntry) => void): (() => void) => {
    return window.api.mcp.onServerLog((log) => callback(log as ServerLogEntry))
  },
  restartServer: async (server: MCPServer): Promise<void> => {
    await window.api.mcp.restartServer(server)
  },
  stopServer: async (server: MCPServer): Promise<void> => {
    await window.api.mcp.stopServer(server)
  },
  updateServer: async (_server: MCPServer): Promise<void> => {
    // 配置类：redux 切片即真相源（同步广播到主进程），无进程参与（同语义）。
  },
  removeServer: async (server: MCPServer): Promise<void> => {
    await window.api.mcp.removeServer(server)
  },
  checkConnectivity: (server: MCPServer): Promise<boolean> => window.api.mcp.checkConnectivity(server),
  /** PATH 中该命令的可执行绝对路径；找不到返回 null（不抛错）。 */
  checkCommand: (command: string): Promise<string | null> => window.api.mcp.checkCommand(command),
  uploadDxt: (file: File): Promise<DxtUploadResult> => window.api.mcp.uploadDxt(file)
}

/** MCP stdio 服务器实际依赖的两个命令（fork 走系统 PATH，不托管二进制）。 */
export const MCP_RUNTIME_COMMANDS = ['npx', 'uvx'] as const
export type McpRuntimeCommand = (typeof MCP_RUNTIME_COMMANDS)[number]

/**
 * 探测 MCP 运行时依赖。命令名固定白名单（不接受调用方自由输入）；
 * 单个命令探测失败按「未知」处理——不谎报为已安装，也不谎报缺失。
 */
export async function probeMcpRuntimeCommands(): Promise<Record<McpRuntimeCommand, string | null>> {
  const results = await Promise.all(
    MCP_RUNTIME_COMMANDS.map(async (command) => {
      try {
        return [command, await mcpApi.checkCommand(command)] as const
      } catch (error) {
        logger.warn(`MCP runtime command probe failed: ${command}`, error as Error)
        return [command, null] as const
      }
    })
  )
  return Object.fromEntries(results) as Record<McpRuntimeCommand, string | null>
}
