/**
 * MCP 主进程 API（批次3 接线：批次1 替身整体换装真实 IPC）。
 *
 * 真通道方法直通主进程 MCPService（preload window.api.mcp 薄转发）；纯配置类
 * updateServer 不经进程——服务器配置真相源是 redux mcp 切片（经 Dsh_SyncMcpServers
 * 整体投影进主进程内存），主进程不回写配置。v0.4.7：uploadDxt（DXT 扩展安装）接线，
 * 走 Mcp_UploadDxt → 主进程 DxtService。安装类余项（getInstallInfo/isBinaryExist/
 * install*Binary）仍为批次1 提示态（MVP 边界见交付注记）。
 */
import { loggerService } from '@logger'
import type { MCPPrompt, MCPResource, MCPServer, MCPTool } from '@renderer/types'
import type { DxtUploadResult, MCPServerLogEntry } from '@shared/config/types'
import { t } from 'i18next'

const logger = loggerService.withContext('McpApi')

const pendingToast = () => window.toast.info(t('settings.mcp.wiring_pending'))

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
    // 配置类：redux 切片即真相源（同步广播到主进程），无进程参与（批次1 同语义）。
  },
  removeServer: async (server: MCPServer): Promise<void> => {
    await window.api.mcp.removeServer(server)
  },
  checkConnectivity: (server: MCPServer): Promise<boolean> => window.api.mcp.checkConnectivity(server),
  uploadDxt: (file: File): Promise<DxtUploadResult> => window.api.mcp.uploadDxt(file),
  getInstallInfo: async (): Promise<{ uvPath: string | null; bunPath: string | null; dir: string | null }> => {
    logger.warn('getInstallInfo is not wired yet')
    return { uvPath: null, bunPath: null, dir: null }
  }
}

export const isBinaryExist = async (_name: string): Promise<boolean> => false

export const installUVBinary = async (): Promise<void> => {
  logger.warn('installUVBinary is not wired yet')
  pendingToast()
  throw new Error(t('settings.mcp.wiring_pending'))
}

export const installBunBinary = async (): Promise<void> => {
  logger.warn('installBunBinary is not wired yet')
  pendingToast()
  throw new Error(t('settings.mcp.wiring_pending'))
}
