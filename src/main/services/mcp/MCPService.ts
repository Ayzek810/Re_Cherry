/**
 * 自 CS_V1 src/main/services/MCPService.ts（1197 行）移植 + 裁剪。
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
 * 引导文案）、内置 inMemory 服务器全家
 *（hub/mcp-auto-install，type:'inMemory' 拒绝连接）、uv/bun bundled binary 兜底
 *（双缺抛引导装 Node.js/uv 的文案）、progress 事件推送、resolveHubTool、
 * callToolById、遥测与上游 CacheService/withSpanFunc（TTLCache/直 logger 替代）。
 *
 * DXT 自裁剪清单恢复（上游 DxtService 移植，services/DxtService.ts）——
 * stdio 启动前按 server.dxtPath 重解 manifest（平台覆写 + 变量替换，失败降级安装期
 * 值并记 warn，上游同语义）、传输 cwd 指向解包目录、removeServer 时删除解包目录。
 *
 * fork 偏离：无 login shell 环境探测（commandResolution.ts 快照 process.env）；
 * 服务器配置注册表（setServers/getServers/getServerById）由渲染层 Dsh_SyncMcpServers
 * 整体投影——配置只进主进程内存，不落盘不进会话日志；getToolsetSignature 供内核
 * MCP 桥挂载漂移比对（listTools 缓存哈希，不可达返回 'unreachable'）。
 *
 * v0.4 逐文件对账后的明示偏离（勘查审计定性，勿当缺陷修）：
 * - HTTP/SSE 不发上游默认应用头（HTTP-Referer/X-Title，Cherry Studio 品牌）——
 *   fork 无品牌站，缺省不发比冒用上游标识诚实；
 * - closeClient 不清日志缓冲（上游 stop/restart 即清）——重启后保留上次日志更可排障，
 *   removeServer 仍清；
 * - listToolsImpl 对缺失 inputSchema 宽容兜底 {type:'object'}（上游整次 listTools 抛错）——
 *   野服务器在发现期可见，调用期才失败是上游形态，fork 不采纳；
 * - getPrompt/getResource（按 key 取用，30min 缓存）未移植——渲染层零消费面；
 * - commandResolution 把 server.env 纳入命令查找环境（上游只用 login shell env）——
 *   服务器私有 PATH 覆盖参与 npx/uvx 解析，行为更优。
 */
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { loggerService } from '@logger'
import DxtService from '@main/services/DxtService'
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

import { findCommandInShellEnv, getInheritedEnv, normalizeMcpCommand } from './commandResolution'
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
  /** DXT 扩展解包/重解配置（目录懒解析，构造期无 IO）。 */
  private readonly dxtService = new DxtService()
  /** 渲染层同步投影的服务器配置注册表（id → 配置）。 */
  private servers = new Map<string, MCPServer>()
  /**
   * `id → 配置内容哈希键` 投影缓存：serverKey 是
   * `JSON.stringify({baseUrl, command, args, env, id, registryUrl})`，此前每个调用点逐次重算
   * ——`emitServerLog` 每个 stderr 分片一次、`listPrompts`/`listResources` 的 60min TTL 缓存键
   * 与日志缓冲键每次都重新构造。同一注册表同步周期内配置是不变量，故随 `setServers` 投影一次。
   */
  private serverKeys = new Map<string, string>()
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

    // 关闭判据此前只是「id 从新表消失」，而 `clients` 的键是**配置内容哈希**。
    // 编辑服务器（改 command/args/env 是设置页常规操作）时 id 仍在表里，旧 key 的 Client 与它
    // spawn 的 stdio 子进程都不会被关闭——用户视角是「改了配置，旧进程还在跑」。按 id 逐条比对
    // 「消失 or key 变化」都关旧客户端，并同步丢弃 pending 项（否则旧 in-flight 会复活旧 key）。
    // key 在这里算一次（原来是各调用点逐次重算）。
    const nextKeys = new Map<string, string>()
    for (const server of next.values()) {
      nextKeys.set(server.id, McpService.computeServerKey(server))
    }

    for (const [id, server] of this.servers) {
      const oldKey = this.serverKeys.get(id) ?? McpService.computeServerKey(server)
      const newKey = nextKeys.get(id)
      if (newKey === oldKey) continue
      void this.closeClientByKey(server, oldKey)
      this.pendingClients.delete(oldKey)
      this.serverKeys.delete(id)
    }

    this.servers = next
    this.serverKeys = nextKeys
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

  /**
   * 配置内容 → 客户端/缓存键（纯函数）。`env` 的键顺序变化会产生不同键，故键序稳定由调用方
   * （渲染层投影的同一次同步）保证；本条与上游同形。
   */
  private static computeServerKey(server: MCPServer): string {
    return JSON.stringify({
      baseUrl: server.baseUrl ?? null,
      command: server.command ?? null,
      args: server.args ?? null,
      env: server.env ?? null,
      id: server.id,
      registryUrl: server.registryUrl ?? null
    })
  }

  /**
   * 取该服务器的配置内容键（读 `setServers` 投影期缓存的那一份）。注册表里还没有的
   * 服务器（如渲染层直传、尚未同步的入参）按同一纯函数就地计算，行为与缓存前一致。
   */
  private getServerKey(server: MCPServer): string {
    return this.serverKeys.get(server.id) ?? McpService.computeServerKey(server)
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

      // DXT 服务器（server.dxtPath）：启动前按解包目录重解 manifest——平台覆写 + 变量替换
      // 得到最终 command/args/env；解析失败降级到安装期值并记 warn（上游同语义，不静默）。
      if (server.dxtPath) {
        const resolvedConfig = this.dxtService.getResolvedMcpConfig(server.dxtPath)
        if (resolvedConfig) {
          cmd = resolvedConfig.command
          args.splice(0, args.length, ...resolvedConfig.args)
          server.env = { ...server.env, ...resolvedConfig.env }
        } else {
          logger.warn(`mcp "${server.name}": failed to resolve DXT config, falling back to install-time values`)
        }
      }

      // 注入面收敛到真正 spawn 的这一步。此前只有 npx/uvx/uv 三条
      // 分支走 findCommandInShellEnv（命令名白名单），其余 command 直接进 StdioClientTransport。
      // 现在裸名走命令名白名单、绝对路径走"存在 + 是文件 + 扩展名受限"，非法即明确报错。
      const normalized = normalizeMcpCommand(cmd)
      if (!normalized.ok) {
        throw new Error(`Invalid MCP server command for "${server.name}": ${normalized.reason}`)
      }
      cmd = normalized.command

      // 命令查找用 process.env 快照；transport 环境在 registryUrl 注入后再取一次
      //（getInheritedEnv(server.env) 两处调用故意分开：中间可能改写 server.env）。
      const lookupEnv = getInheritedEnv(server.env)

      // 裸名解析按解析后的 cmd 判（非 DXT 时 cmd === server.command，行为不变；
      // DXT 覆写后以上游 manifest 解析结果为准，不被 npx 查找反向覆盖）。
      const registryCommand = cmd
      if ((registryCommand === 'uvx' || registryCommand === 'uv') && server.registryUrl) {
        server.env = {
          ...server.env,
          UV_DEFAULT_INDEX: server.registryUrl,
          PIP_INDEX_URL: server.registryUrl
        }
      }
      if (registryCommand === 'npx' && server.registryUrl) {
        server.env = { ...server.env, NPM_CONFIG_REGISTRY: server.registryUrl }
      }

      // 裸名（node/python/bun/npx…）由 PATH 解析：Windows 下 `node` 实际是 `node.exe`，
      // StdioClientTransport 的解析不查 PATHEXT，故先解析成绝对路径再交给它。
      if (!path.isAbsolute(cmd) && !path.win32.isAbsolute(cmd)) {
        const resolved = await findCommandInShellEnv(cmd, lookupEnv)
        if (resolved === null) {
          // bundled binary 兜底不在本构建（见头注释）：双缺时引导安装。
          if (cmd === 'npx') {
            throw new Error(
              'npx not found in PATH. Please install Node.js (which includes npx) from https://nodejs.org and restart the app.'
            )
          }
          if (cmd === 'uvx' || cmd === 'uv') {
            throw new Error(
              `${cmd} not found in PATH. Please install uv from https://github.com/astral-sh/uv and restart the app.`
            )
          }
          throw new Error(`MCP server command "${cmd}" was not found in PATH`)
        }
        cmd = resolved
      }

      const transport = new StdioClientTransport({
        command: cmd,
        args,
        env: getInheritedEnv(server.env),
        stderr: 'pipe',
        // DXT 服务器以解包目录为工作目录（相对入口/资源可解析，上游同语义）。
        ...(server.dxtPath ? { cwd: server.dxtPath } : {})
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
    await this.closeClientByKey(server, this.getServerKey(server))
  }

  /**
   * 按**显式 key** 关闭客户端并清缓存（注册表替换时旧 key 已不在 `serverKeys` 里，
   * 必须由调用方把它带进来）。
   */
  private async closeClientByKey(server: MCPServer, serverKey: string): Promise<void> {
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
    try {
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
    } catch (error) {
      // 上游同语义：大量 stdio 服务器不实现 prompts——method-not-found（-32601）
      // 静默按空清单；其余失败也返回空（不缓存重复炸），仅落日志。
      const code = (error as { code?: number }).code
      if (code !== -32601) {
        logger.warn(`mcp: listPrompts failed for "${server.name}", returning empty list`, toLoggableError(error))
      }
      return []
    }
  }

  async listResources(server: MCPServer): Promise<MCPResource[]> {
    const serverKey = this.getServerKey(server)
    const cacheKey = `mcp:list_resources:${serverKey}`
    const cached = this.cache.get<MCPResource[]>(cacheKey)
    if (cached !== undefined) return cached
    const client = await this.initClient(server)
    try {
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
    } catch (error) {
      // 上游同语义：不实现 resources 的服务器按空清单处理（见 listPrompts 注）。
      const code = (error as { code?: number }).code
      if (code !== -32601) {
        logger.warn(`mcp: listResources failed for "${server.name}", returning empty list`, toLoggableError(error))
      }
      return []
    }
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
    // 上游同语义：预热失败向上抛——重启坏服务器必须给用户失败信号，不静默成功。
    await this.initClient(server)
  }

  async stopServer(server: MCPServer): Promise<void> {
    await this.closeClient(server)
    this.emitServerLog(server, { timestamp: Date.now(), level: 'info', message: 'Server stopped', source: 'client' })
  }

  async removeServer(server: MCPServer): Promise<void> {
    await this.closeClient(server)
    this.logBuffer.remove(this.getServerKey(server))
    // DXT 服务器：连带删除解包目录。清理失败**不静默**：配置一旦从
    // 注册表消失，界面就再也看不到这个服务器，留在磁盘上的解包目录（含可执行物）成了孤儿。
    // 失败即上抛——注册表条目保留，用户可重试（上游"只记日志、不阻断移除"会吞掉这个信号）。
    if (server.dxtPath) {
      const cleaned = this.dxtService.cleanupDxtServerByPath(server.dxtPath)
      // 目录本就不在（已被清过 / 用户手工删过）＝ 无需信号；目录仍在而清理失败＝ 如实报错，
      // 让注册表条目保留、用户可重试。
      if (!cleaned && this.dxtService.dxtServerDirExists(server.dxtPath)) {
        throw new Error(`Failed to remove the DXT server directory: ${server.dxtPath}`)
      }
      logger.debug(`mcp "${server.name}": DXT server directory cleaned (${server.dxtPath})`)
    }
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
      // 上游同形状：只回 serverInfo.version（不拼服务名）。
      if (version === undefined) return null
      return typeof version.version === 'string' && version.version.length > 0 ? version.version : null
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
