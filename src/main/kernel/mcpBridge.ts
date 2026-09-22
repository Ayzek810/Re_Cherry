/**
 * MCP 桥模块工厂（批次3 MCP 接线）。
 *
 * 形态（a）每服务器一个外置挂载单元：渲染层 messageThunk 把 `mcp:<serverId>` 并入
 * externalTools 随发送参数上行；topics.setup 对该类 id 经主进程 MCPService 查配置、
 * listTools 拉工具清单后，用本工厂生成一个 cordis 插件模块（agentCtx.plugin 挂载），
 * 插件内把每个 MCP 工具展开成一个 defineTool（工具名 = mcp__{server}__{tool}，
 * 63 字符，与 MCPTool.id 同规则同源 @shared/utils/mcpToolName）。工厂每次生成新
 * 模块对象，规避同模块重复 plugin 的语义问题；工具面跟轮走/漂移重挂全复用既有
 * mountedTools 机制（签名比对见 topics.ts mcpSignature）。
 *
 * 执行：桥 execute 直接函数调用同进程的 mcpService.callTool（聊天路径零新增 IPC）；
 * 多模态结果压成文本占位（上游 mcpResultToTextSummary 同语义，防 base64 超限）。
 * UI 工具卡由 kernelChat 投影自动覆盖，零新增。
 *
 * MVP 边界：`server.disabledAutoApproveTools` 中的工具不挂载（上游语义是"调时弹
 * 确认"，fork 内核无单工具审批粒度——不挂载比静默放行严格，无静默执行风险）；
 * OAuth/DXT/hub 服务器不在批次3（见主进程 MCPService 头注释）；复杂 JSON Schema
 * 经有界转换映射到 dsh 参数 DSL，无法表达的节点回退 {type:'json'} 无约束节点。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterPropertySpec, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'
import { buildFunctionCallToolName } from '@shared/utils/mcpToolName'
import type { MCPServer, MCPTool } from '@types'

import { mcpService } from '../services/mcp/MCPService'

const logger = loggerService.withContext('McpBridge')

/** 转换递归深度上限：超过即回退 json 无约束节点（防恶意/异常深 schema）。 */
const MAX_SCHEMA_DEPTH = 4

function descriptionOf(node: Record<string, unknown>, suffix = ''): string | undefined {
  const raw = node.description
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text && !suffix) return undefined
  return `${text}${suffix}`.trim() || undefined
}

/**
 * MCP 工具 inputSchema（JSON Schema object 节点）→ dsh 参数 DSL 属性映射。
 * 有界映射：标量/enum 直映；array/object 递归（深度封顶）；其余复合（allOf/anyOf/
 * 无 type）回退 {type:'json'}——dsh 的无约束 lossless JSON 节点，任何 JSON 都合法。
 */
export function convertMcpInputSchema(schema: {
  properties?: Record<string, unknown>
  required?: string[]
}): ParameterSchemaSpec {
  const params: ParameterSchemaSpec = {}
  const required = new Set(schema.required ?? [])
  const properties = schema.properties ?? {}
  for (const [key, raw] of Object.entries(properties)) {
    const spec = convertNode(raw as Record<string, unknown>, required.has(key), 0)
    if (spec !== undefined) params[key] = spec
  }
  return params
}

function convertNode(
  node: Record<string, unknown>,
  isRequired: boolean,
  depth: number
): ParameterPropertySpec | undefined {
  // 构造期用宽松结构承载（外部 JSON Schema 天然无 dsh 类型），return 处受控断言；
  // 形状正确性由 dsh defineTool 编译/运行时校验兜底（validateArgs/assertSupportedJsonSchema）。
  const common: Record<string, unknown> = {}
  if (isRequired) common.required = true
  const description = descriptionOf(node)
  if (description !== undefined) common.description = description.slice(0, 800)
  if (depth > MAX_SCHEMA_DEPTH) return jsonSpec(node, isRequired, description)
  switch (node.type) {
    case 'string': {
      const spec: Record<string, unknown> = { type: 'string', ...common }
      const enumValues = Array.isArray(node.enum) ? node.enum.filter((v): v is string => typeof v === 'string') : []
      if (enumValues.length > 0) spec.enum = enumValues
      return spec as unknown as ParameterPropertySpec
    }
    case 'number':
    case 'integer':
      return { type: 'number', ...common } as unknown as ParameterPropertySpec
    case 'boolean':
      return { type: 'boolean', ...common } as unknown as ParameterPropertySpec
    case 'array': {
      const spec: Record<string, unknown> = { type: 'array', ...common }
      const items = node.items as Record<string, unknown> | undefined
      if (items !== undefined && items !== null && typeof items === 'object') {
        const itemSpec = convertNode(items, false, depth + 1)
        if (itemSpec !== undefined) spec.items = itemSpec
      }
      return spec as unknown as ParameterPropertySpec
    }
    case 'object': {
      const spec: Record<string, unknown> = {
        type: 'object',
        additionalProperties: node.additionalProperties !== false,
        ...common
      }
      const nested = node.properties as Record<string, unknown> | undefined
      if (nested !== undefined && typeof nested === 'object') {
        const nestedRequired = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
        const props: ParameterSchemaSpec = {}
        for (const [key, raw] of Object.entries(nested)) {
          const itemSpec = convertNode(raw as Record<string, unknown>, nestedRequired.has(key), depth + 1)
          if (itemSpec !== undefined) props[key] = itemSpec
        }
        spec.properties = props
      }
      return spec as unknown as ParameterPropertySpec
    }
    default:
      // 无 type / 复合关键字（allOf/anyOf/oneOf 非 dsh 形态）：无约束 JSON 回退。
      return jsonSpec(node, isRequired, description)
  }
}

function jsonSpec(node: Record<string, unknown>, isRequired = false, description?: string): ParameterPropertySpec {
  const spec: ParameterPropertySpec = { type: 'json' }
  if (isRequired) spec.required = true
  const desc = description ?? descriptionOf(node, ' (schema too complex to describe; pass lossless JSON)')
  if (desc !== undefined) spec.description = desc.slice(0, 800)
  return spec
}

/** MCP 调用结果 → 纯文本（上游 mcpResultToTextSummary 同语义：多模态压占位防 base64 超限）。 */
export function mcpResultToTextSummary(result: { content?: unknown }): string {
  const content = Array.isArray(result?.content) ? (result.content as unknown[]) : []
  if (content.length === 0) return JSON.stringify(result)
  const parts: string[] = []
  for (const raw of content) {
    const item = (raw ?? {}) as Record<string, unknown>
    switch (item.type) {
      case 'text':
        parts.push(typeof item.text === 'string' ? item.text : '')
        break
      case 'image':
        parts.push(`[Image: ${String(item.mimeType ?? 'image/png')}, delivered to user]`)
        break
      case 'audio':
        parts.push(`[Audio: ${String(item.mimeType ?? 'audio/mp3')}, delivered to user]`)
        break
      case 'resource': {
        const resource = item.resource as Record<string, unknown> | undefined
        if (resource !== null && typeof resource === 'object' && typeof resource.blob === 'string') {
          parts.push(`[Resource: ${String(resource.mimeType ?? resource.uri ?? 'unknown')}, delivered to user]`)
        } else if (resource !== null && typeof resource === 'object' && typeof resource.text === 'string') {
          parts.push(resource.text)
        } else {
          parts.push('[Resource: unavailable]')
        }
        break
      }
      default:
        parts.push(JSON.stringify(item))
    }
  }
  return parts.filter((p) => p.length > 0).join('\n') || JSON.stringify(result)
}

/**
 * 生成一个 MCP 服务器的桥模块（每次调用新对象；mount 一次 = plugin 一次）。
 * @param tools mcpService.listTools 的结果；不可达时传 []——挂载一个零工具桥
 *（面 id 仍在，模型知道该服务器本轮在但无工具可调，诚实于 unreachable 状态）。
 */
export function createMcpBridgeModule(
  server: MCPServer,
  tools: MCPTool[]
): {
  name: string
  inject: string[]
  apply: (ctx: Context) => void
} {
  // 审批白名单排除式（上游 isToolAutoApproved 语义的 MVP 化）：用户明确排除
  // 自动批准的工具不挂载——严格于上游的"调用时确认"，绝不静默放行。
  const excluded = new Set(server.disabledAutoApproveTools ?? [])
  const mountable = tools.filter((tool) => !excluded.has(tool.name))

  return {
    name: `mcp-bridge:${server.id}`,
    inject: ['tools'],
    apply(ctx) {
      for (const tool of mountable) {
        ctx.tools.register(defineBridgeTool(server, tool))
      }
      if (mountable.length !== tools.length) {
        logger.info(
          `mcp bridge "${server.name}": ${tools.length - mountable.length} tool(s) excluded by disabledAutoApproveTools`
        )
      }
    }
  }
}

function defineBridgeTool(server: MCPServer, tool: MCPTool) {
  const toolName = tool.id || buildFunctionCallToolName(server.name, tool.name)
  const description = (tool.description?.trim() || `Tool "${tool.name}" from MCP server "${server.name}".`).slice(
    0,
    2000
  )
  return defineTool({
    name: toolName,
    description,
    parameters: convertMcpInputSchema(tool.inputSchema),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const response = await mcpService.callTool(
        { server, name: tool.name, args: JSON.stringify(args ?? {}) },
        exec.signal
      )
      if (response?.isError) {
        throw new Error(mcpResultToTextSummary(response))
      }
      const text = mcpResultToTextSummary(response)
      logger.info(`mcp "${server.name}"."${tool.name}" ok (${text.length} chars)`)
      return { server: server.name, tool: tool.name, text }
    }
  })
}
