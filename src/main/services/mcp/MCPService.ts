/**
 * v0.3.2 批次3 自 CS_V1 src/main/services/MCPService.ts（1197 行）移植 + 裁剪。
 *
 * **做**（上游同语义）：客户端缓存（serverKey=配置 JSON 哈希键，ping 1s 复用）、
 * pendingClients 并发去重、stdio/sse/streamableHttp 三传输、connect 超时下限 180s、
 * listTools（5min TTL + zod inputSchema 校验 + mcp__{server}__{tool} 命名）、
 * listPrompts/listResources（60min TTL）、list_changed 通知清缓存、
 * callTool（args JSON.parse、timeout=server.timeout||60s、longRunning 加
 * resetTimeoutOnProgress+10min、AbortController 登记 + abortTool）、
 * restart/stop/remove、checkConnectivity、getServerVersion、ServerLogBuffer(200)
 * + onServerLog 主进程回调注册表、npx/uvx/uv 命令解析（shell env 快照 + registryUrl
 * 环境注入）、stderr → 服务器日志流。
 *
 * **裁剪清单（本构建不做，调用即明错）**：OAuth 全套（UnauthorizedError 直接抛出
 * 引导文案）、DXT（独立服务与 getResolvedMcpConfig）、内置 inMemory 服务器全家
 *（hub/mcp-auto-install，type:'inMemory' 拒绝连接）、uv/bun bundled binary 兜底
 *（双缺抛引导装 Node.js/uv 的文案）、progress 事件推送、resolveHubTool、
 * callToolById、遥测与上游 CacheService/withSpanFunc（TTLCache/直 logger 替代）。
 *
 * fork 偏离：无 login shell 环境探测（commandResolution.ts 快照 process.env）；
 * 服务器配置注册表（setServers/getServers/getServerById）由渲染层 Dsh_SyncMcpServers
 * 整体投影——配置只进主进程内存，不落盘不进会话日志；getToolsetSignature 供内核
 * MCP 桥挂载漂移比对（listTools 缓存哈希，不可达返回 'unreachable'）。
 */
import { createHash, randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { buildFunctionCallToolName } from '@shared/utils/mcpToolName'
import type { MCPCallToolResponse, MCPPrompt, MCPResource, MCPServer, MCPTool } from '@types'
import { MCPToolInputSchema, MCPToolOutputSchema } from '@types'
import { app, net } from 'electron'

import { findCommandInShellEnv, getInheritedEnv } from './commandResolution'
import { type MCPServerLogEntryWithServer, ServerLogBuffer } from './ServerLogBuffer'
import { TTLCache } from './ttlCache'

const logger = loggerService.withContext('MCPService')

/** fork logger 上下文只接受 Error | NullableObject：未知抛出物统一包成 Error。 */
function toLoggableError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

const LIST_TOOLS_TTL = 5 * 60 * 1000
const LIST_PROMPTS_TTL = 60 * 60 * 1000
const LIST_RESOURCES_TTL = 60 * 60 * 1000
/** MCP `initialize` 请求超时下限：激活一次性动作，余量给足（上游 180s 同值）。 */
const MCP_CONNECT_TIMEOUT_FLOOR_MS = 180_000

export class McpService {
  private static instance: McpService | null = null

  private clients = new Map<string, Client>()
  private pendingClients = new Map<string, Promise<Client>>()
  private activeToolCalls = new Map<string, AbortController>()
  private readonly logBuffer = new ServerLogBuffer(200)
  private readonly cache = new TTLCache()
  /** 渲染层同步投影的服务器配置注册表（id → 配置）。 */
  private servers = new Map<string, MCPServer>()
  private readonly logSubscribers = new Set<(log: MCPServerLogEntryWithServer) => void>()

  static getInstance(): McpService {
    if (!McpService.instance) {
      McpService.instance = new McpService()
      logger.info('MCPService initialized')
    }
    return McpService.instance
  }

  private constructor() {}

  // ===========================================================================
  // 配置注册表（渲染层 Dsh_SyncMcpServers 投影；内核桥挂载时按 id 反查）
  // ===========================================================================

  setServers(servers: MCPServer[]): void {
    const next = new Map<string, MCPServer>()
    for (const server of servers) {
      if (server && typeof server.id === 'string' && server.id.length > 0) {
        next.set(server.id, server)
      }
    }
    // 配置已删除的服务器：关闭其客户端并清缓存（serverKey 按配置内容算，
    // 这里按"新注册表里已不存在的 id"关闭）。
    for (const [id] of this.servers) {
      if (!next.has(id)) {
        const server = this.servers.get(id)
        if (server !== undefined) {
          void this.closeClient(server)
        }
      }
    }
    this.servers = next
    logger.info(`mcp: synced ${next.size} server config(s) from renderer`)
  }

  getServers(): MCPServer[] {
    return [...this.servers.values()]
  }

  getServerById(id: string): MCPServer | undefined {
    return this.servers.get(id)
  }

  // ===========================================================================
  // 客户端生命周期
  // ===========================================================================

  private getServerKey(server: MCPServer): string {
    return JSON.stringify({
      baseUrl: server.baseUrl ?? null,
      command: server.command ?? null,
      args: server.args ?? null,
      env: server.env ?? null,
      id: server.id
    })
  }

  async initClient(server: MCPServer): Promise<Client> {
    const serverKey = this.getServerKey(server)

    const pendingClient = this.pendingClients.get(serverKey)
    if (pendingClient) return pendingClient

    const existingClient = this.clients.get(serverKey)
    if (existingClient) {
      try {
        // 短超时 ping 复用既有客户端（上游同语义）
        const pingResult = await existingClient.ping({ timeout: 1000 })
        if (pingResult) return existingClient
        this.clients.delete(serverKey)
      } catch (error) {
        logger.warn(`mcp: ping failed for "${server.name}", recreating client`, {
          error: error instanceof Error ? error.message : String(error)
        })
        this.clients.delete(serverKey)
      }
    }

    const initPromise = (async () => {
      try {
        const client = new Client({ name: 'Re_Cherry', version: app.getVersion() }, { capabilities: {} })
        const transport = await this.initTransport(server)

        const connectOptions: RequestOptions = {
          timeout: Math.max((server.timeout ?? 0) * 1000, MCP_CONNECT_TIMEOUT_FLOOR_MS)
        }
        await client.connect(transport, connectOptions)

        this.clients.set(serverKey, client)
        this.setupNotificationHandlers(client, server)
        this.clearServerCache(serverKey)
        this.emitServerLog(server, {
          timestamp: Date.now(),
          level: 'info',
          message: 'Server connected',
          source: 'client'
        })
        logger.info(`mcp: activated server "${server.name}"`)
        return client
      } catch (error) {
        this.emitServerLog(server, {
          timestamp: Date.now(),
          level: 'error',
          message: `Error activating server: ${error instanceof Error ? error.message : String(error)}`,
          source: 'client'
        })
        logger.error(`mcp: error activating server "${server.name}"`, toLoggableError(error))
        throw error
      } finally {
        this.pendingClients.delete(serverKey)
      }
    })()

    this.pendingClients.set(serverKey, initPromise)
    return initPromise
  }

  private async initTransport(
    server: MCPServer
  ): Promise<StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport> {
    if (server.type === 'inMemory') {
      // 内置 inMemory 服务器（上游 hub/mcp-auto-install 全家）不在本构建（见头注释）。
      throw new Error('Builtin inMemory MCP servers are not supported in this build')
    }

    if (server.baseUrl) {
      const fetchAdapter = async (url: string | URL, init: RequestInit | undefined): Promise<Response> => {
        return net.fetch(typeof url === 'string' ? url : url.toString(), init)
      }
      const headers = { ...server.headers }
      if (server.type === 'streamableHttp') {
        return new StreamableHTTPClientTransport(new URL(server.baseUrl), {
          fetch: fetchAdapter,
          requestInit: { headers }
        })
      }
      if (server.type === 'sse') {
        return new SSEClientTransport(new URL(server.baseUrl), {
          eventSourceInit: { fetch: fetchAdapter },
          requestInit: { headers }
        })
      }
      throw new Error(`Invalid MCP server type "${String(server.type)}" for URL transport`)
    }

    if (server.command) {
      let cmd = server.command
      const args = [...(server.args ?? [])]
      // 命令查找用 process.env 快照；transport 环境在 registryUrl 注入后再取一次
      //（getInheritedEnv(server.env) 两处调用故意分开：中间可能改写 server.env）。
      const lookupEnv = getInheritedEnv(server.env)

      if (server.command === 'npx' || server.command === 'uvx' || server.command === 'uv') {
        const resolved = await findCommandInShellEnv(server.command, lookupEnv)
        if (resolved === null) {
          // bundled binary 兜底不在本构建（见头注释）：双缺时引导安装。
          throw new Error(
            server.command === 'npx'
              ? 'npx not found in PATH. Please install Node.js (which includes npx) from https://nodejs.org and restart the app.'
              : `${server.command} not found in PATH. Please install uv from https://github.com/astral-sh/uv and restart the app.`
          )
        }
        cmd = resolved
        if (server.command === 'npx' && server.registryUrl) {
          server.env = { ...server.env, NPM_CONFIG_REGISTRY: server.registryUrl }
        }
        if ((server.command === 'uvx' || server.command === 'uv') && server.registryUrl) {
          server.env = {
            ...server.env,
            UV_DEFAULT_INDEX: server.registryUrl,
            PIP_INDEX_URL: server.registryUrl
          }
        }
      }

      const transport = new StdioClientTransport({
        command: cmd,
        args,
        env: getInheritedEnv(server.env),
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (data: Buffer) => {
        const message = data.toString().trim()
        if (message.length === 0) return
        logger.debug(`mcp "${server.name}" stderr: ${message.slice(0, 500)}`)
        this.emitServerLog(server, { timestamp: Date.now(), level: 'stderr', message, source: 'stdio' })
      })
      return transport
    }

    throw new Error('Either baseUrl or command must be provided')
  }

  private setupNotificationHandlers(client: Client, server: MCPServer): void {
    const serverKey = this.getServerKey(server)
    try {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        logger.debug(`mcp: tools list changed for "${server.name}"`)
        this.cache.remove(`mcp:list_tools:${serverKey}`)
      })
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        this.cache.remove(`mcp:list_resources:${serverKey}`)
      })
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        this.cache.remove(`mcp:list_prompts:${serverKey}`)
      })
      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        const message =
          typeof notification.params?.data === 'string'
            ? notification.params.data
            : JSON.stringify(notification.params?.data ?? '')
        if (message.length === 0) return
        this.emitServerLog(server, {
          timestamp: Date.now(),
          level: (notification.params?.level as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
          message,
          source: notification.params?.logger ?? 'server'
        })
      })
    } catch (error) {
      logger.error(`mcp: failed to set up notification handlers for "${server.name}"`, toLoggableError(error))
    }
  }

  private async closeClient(server: MCPServer): Promise<void> {
    const serverKey = this.getServerKey(server)
    const client = this.clients.get(serverKey)
    if (client !== undefined) {
      this.clients.delete(serverKey)
      try {
        await client.close()
      } catch (error) {
        logger.warn(`mcp: error closing client for "${server.name}"`, toLoggableError(error))
      }
    }
    this.clearServerCache(serverKey)
  }

  private clearServerCache(serverKey: string): void {
    this.cache.remove(`mcp:list_tools:${serverKey}`)
    this.cache.remove(`mcp:list_prompts:${serverKey}`)
    this.cache.remove(`mcp:list_resources:${serverKey}`)
  }

  // ===========================================================================
  // 发现（工具/提示词/资源）
  // ===========================================================================

  private async listToolsImpl(server: MCPServer): Promise<MCPTool[]> {
    const client = await this.initClient(server)
    const { tools } = await client.listTools()
    return tools.map((tool) => ({
      ...tool,
      inputSchema: MCPToolInputSchema.parse(tool.inputSchema ?? { type: 'object' }),
      outputSchema: tool.outputSchema ? MCPToolOutputSchema.parse(tool.outputSchema) : undefined,
      id: buildFunctionCallToolName(server.name, tool.name),
      serverId: server.id,
      serverName: server.name,
      type: 'mcp' as const
    }))
  }

  async listTools(server: MCPServer): Promise<MCPTool[]> {
    const serverKey = this.getServerKey(server)
    const cacheKey = `mcp:list_tools:${serverKey}`
    const cached = this.cache.get<MCPTool[]>(cacheKey)
    if (cached !== undefined) return cached
    const result = await this.listToolsImpl(server)
    this.cache.set(cacheKey, result, LIST_TOOLS_TTL)
    return result
  }

  async listPrompts(server: MCPServer): Promise<MCPPrompt[]> {
    const serverKey = this.getServerKey(server)
    const cacheKey = `mcp:list_prompts:${serverKey}`
    const cached = this.cache.get<MCPPrompt[]>(cacheKey)
    if (cached !== undefined) return cached
    const client = await this.initClient(server)
    const { prompts } = await client.listPrompts()
    const result: MCPPrompt[] = prompts.map((prompt) => ({
      id: `prompt-${server.id}-${prompt.name}`,
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments?.map((arg) => ({
        name: arg.name,
        description: arg.description,
        required: arg.required ?? false
      })),
      serverId: server.id,
      serverName: server.name
    }))
    this.cache.set(cacheKey, result, LIST_PROMPTS_TTL)
    return result
  }

  async listResources(server: MCPServer): Promise<MCPResource[]> {
    const serverKey = this.getServerKey(server)
    const cacheKey = `mcp:list_resources:${serverKey}`
    const cached = this.cache.get<MCPResource[]>(cacheKey)
    if (cached !== undefined) return cached
    const client = await this.initClient(server)
    const { resources } = await client.listResources()
    const result: MCPResource[] = resources.map((resource) => ({
      serverId: server.id,
      serverName: server.name,
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType
    }))
    this.cache.set(cacheKey, result, LIST_RESOURCES_TTL)
    return result
  }

  /**
   * 内核桥挂载漂移签名：工具清单（id + inputSchema）稳定 JSON 的哈希。
   * 服务器不可达时返回 'unreachable'（签名参与 mountedTools 比对，服务恢复后自动重挂）。
   */
  async getToolsetSignature(server: MCPServer): Promise<string> {
    try {
      const tools = await this.listTools(server)
      return createHash('sha256')
        .update(JSON.stringify(tools.map((tool) => [tool.id, tool.inputSchema])))
        .digest('hex')
        .slice(0, 16)
    } catch {
      return 'unreachable'
    }
  }

  // ===========================================================================
  // 调用
  // ===========================================================================

  async callTool(
    params: { server: MCPServer; name: string; args?: string; callId?: string },
    signal?: AbortSignal
  ): Promise<MCPCallToolResponse> {
    const { server, name } = params
    const toolCallId = params.callId ?? randomUUID()
    const abortController = new AbortController()
    // 外部 signal（内核工具 exec.signal）中止时联动内部 controller。
    const onExternalAbort = () => abortController.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })
    this.activeToolCalls.set(toolCallId, abortController)

    try {
      let args: unknown = params.args
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          logger.warn(`mcp: args parse error for "${server.name}"."${name}"`)
        }
        if (args === '') args = {}
      }
      const client = await this.initClient(server)
      const toolArguments = args as Record<string, unknown> | undefined
      const result = (await client.callTool({ name, arguments: toolArguments }, undefined, {
        timeout: server.timeout ? server.timeout * 1000 : 60000,
        resetTimeoutOnProgress: server.longRunning,
        maxTotalTimeout: server.longRunning ? 10 * 60 * 1000 : undefined,
        signal: abortController.signal
      })) as MCPCallToolResponse
      return result
    } catch (error) {
      logger.error(`mcp: error calling "${server.name}"."${name}"`, toLoggableError(error))
      throw error
    } finally {
      signal?.removeEventListener('abort', onExternalAbort)
      this.activeToolCalls.delete(toolCallId)
    }
  }

  abortTool(callId: string): void {
    this.activeToolCalls.get(callId)?.abort()
  }

  // ===========================================================================
  // 服务器管理
  // ===========================================================================

  async restartServer(server: MCPServer): Promise<void> {
    await this.closeClient(server)
    this.emitServerLog(server, { timestamp: Date.now(), level: 'info', message: 'Server restarted', source: 'client' })
    try {
      await this.initClient(server)
    } catch (error) {
      logger.warn(`mcp: restart warm-up failed for "${server.name}" (will retry on next use)`, toLoggableError(error))
    }
  }

  async stopServer(server: MCPServer): Promise<void> {
    await this.closeClient(server)
    this.emitServerLog(server, { timestamp: Date.now(), level: 'info', message: 'Server stopped', source: 'client' })
  }

  async removeServer(server: MCPServer): Promise<void> {
    await this.closeClient(server)
    this.logBuffer.remove(this.getServerKey(server))
    this.emitServerLog(server, { timestamp: Date.now(), level: 'info', message: 'Server removed', source: 'client' })
  }

  async checkConnectivity(server: MCPServer): Promise<boolean> {
    try {
      await this.initClient(server)
      await this.listTools(server)
      return true
    } catch (error) {
      logger.warn(`mcp: connectivity check failed for "${server.name}"`, toLoggableError(error))
      await this.closeClient(server)
      return false
    }
  }

  async getServerVersion(server: MCPServer): Promise<string | null> {
    try {
      const client = await this.initClient(server)
      const version = client.getServerVersion()
      if (version === undefined) return null
      return (
        [version.name, version.version].filter((part) => typeof part === 'string' && part.length > 0).join(' ') || null
      )
    } catch {
      return null
    }
  }

  // ===========================================================================
  // 日志
  // ===========================================================================

  getServerLogs(server?: MCPServer): MCPServerLogEntryWithServer[] {
    if (server === undefined) return this.logBuffer.getAll()
    return this.logBuffer.get(this.getServerKey(server))
  }

  /** 注册主进程日志回调（返回解绑函数）。 */
  onServerLog(callback: (log: MCPServerLogEntryWithServer) => void): () => void {
    this.logSubscribers.add(callback)
    return () => {
      this.logSubscribers.delete(callback)
    }
  }

  private emitServerLog(server: MCPServer, entry: MCPServerLogEntryWithServer): void {
    const withServer: MCPServerLogEntryWithServer = { ...entry, serverId: server.id }
    this.logBuffer.append(this.getServerKey(server), withServer)
    for (const subscriber of this.logSubscribers) {
      try {
        subscriber(withServer)
      } catch (error) {
        logger.warn('mcp: log subscriber error', toLoggableError(error))
      }
    }
  }
}

export const mcpService = McpService.getInstance()
