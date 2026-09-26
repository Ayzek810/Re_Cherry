// fork 缝（原创）：
// V2 引擎是 AiStreamManager（AI SDK v6 客户端链：AIService.streamText → listener 广播）；
// fork 引擎是内核 ctx.llm.stream 公开缝——网关作为 lightLlm 之外的第二类生产级消费者，
// 直接喂 GenerateOptions、把 dsh 原始 StreamChunk 翻译回 UIMessageChunk 供 adapters 消费。
//
// 数据源：getKernel()（@main/kernel）；kernel 未 boot 时显式报错（网关请求必须走内核
// provider 路由，不做静默降级）。消息组装照 lightLlm.ts 的 Message 工厂用法
//（createUserMessage / createAssistantMessage / createToolResultMessage）；
// tools 映射到 GenerateOptions.ToolSchema（pi-ai 侧 {name, description, parameters} 近 1:1）。
// StreamChunk → UIMessageChunk 的逐条映射见 mapStreamChunk。

import { asSchema, type ToolSet, type UIMessageChunk } from 'ai'
import { CallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import {
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  type AssistantMessage,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
  type ToolSchema,
  type UserMessage
} from '@deepseek-ai/dsh-llm'
import { loggerService } from '@logger'
import { getKernel } from '@main/kernel'
import { PROTOCOL_BY_TYPE, type KernelProviderInput } from '@main/kernel/providers'

import type { CherryUIMessage } from '../adapters/interfaces'

const logger = loggerService.withContext('ApiGatewayLlmEngine')

/** 引擎单次调用参数：proxyStream 把 OpenAI wire 的采样/工具面收敛到此处。 */
export interface GatewayStreamOverrides {
  /** 客户端断连 / 空闲超时的取消通道（ctx.llm.stream 原生吃 GenerateOptions.signal）。 */
  signal?: AbortSignal
  /** 追加到消息前导 system 之后的系统提示（网关路由暂不产生，为对称保留）。 */
  system?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
  /** 思考档位（KERNEL_REASONING_LEVELS 词表；批次3b 无推导源，恒 undefined）。 */
  reasoningEffort?: string
  /** OpenAI function tools（proxyStream 已解析出的 converters ToolSet）。 */
  tools?: ToolSet
}

/** 一次性去重告警：同类部件只警告一次（流式请求高频触发，不能每部件刷日志）。 */
const warnedDrops = new Set<string>()
function warnOnce(key: string, detail: string): void {
  if (warnedDrops.has(key)) return
  warnedDrops.add(key)
  logger.warn(`api-gateway engine: ${detail} (further occurrences silenced)`)
}

/** fork 引擎的 EndpointType = pi-ai 路由协议 id（inlineSystemMessages 的白名单语义不变）。 */
export function resolveEndpointType(provider: KernelProviderInput): string | undefined {
  return PROTOCOL_BY_TYPE[provider.type]
}

/**
 * UIMessage 部件 → dsh Message 映射。
 *
 * - 前导 system 消息折叠进 GenerateOptions.system（provider 的 system 槽，V2 同语义）；
 *   中置 system 消息（anthropic/responses 白名单放行的那部分）保留 role:'system' 传给
 *   内核——pi-ai 会把它降级为 user 文本（V2 的 mid-conversation-system beta 通道 fork 无）。
 * - text → TextBlock；reasoning → ReasoningBlock；dynamic-tool → ToolCallBlock +
 *   （有结果时）跟随一条 ToolResultMessage；file / data-* / 未知部件 → 丢字段不丢消息
 *   并 warnOnce（丢空后无剩余部件的消息整体丢弃并告警——空 content 无法上线）。
 */
function splitLeadingSystem(messages: CherryUIMessage[]): { leadingSystemTexts: string[]; rest: CherryUIMessage[] } {
  const leadingSystemTexts: string[] = []
  let i = 0
  for (; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role !== 'system') break
    const text = message.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .filter(Boolean)
      .join('\n\n')
    if (text) leadingSystemTexts.push(text)
  }
  return { leadingSystemTexts, rest: messages.slice(i) }
}

function toolOutputToText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function uiPartsToBlocks(
  message: CherryUIMessage
): { blocks: Message['content']; toolResults: Array<{ callId: string; text: string; isError: boolean }> } {
  const blocks: Message['content'] = []
  const toolResults: Array<{ callId: string; text: string; isError: boolean }> = []

  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'reasoning') {
      if (part.text) blocks.push({ type: 'reasoning', text: part.text })
      continue
    }
    if (part.type === 'dynamic-tool') {
      blocks.push({
        type: 'tool-call',
        id: CallId(part.toolCallId),
        name: part.toolName,
        arguments: JSON.stringify(part.input ?? {})
      })
      if (part.state === 'output-available') {
        toolResults.push({ callId: part.toolCallId, text: toolOutputToText(part.output), isError: false })
      } else if (part.state === 'output-error') {
        toolResults.push({ callId: part.toolCallId, text: part.errorText ?? 'tool execution failed', isError: true })
      }
      continue
    }
    // file / step-start / data-* / 未知部件：丢字段不丢消息（warnOnce 去重）。
    warnOnce(`part:${part.type}`, `UIMessage part "${part.type}" has no dsh equivalent and was dropped`)
  }

  return { blocks, toolResults }
}

function uiMessagesToDshMessages(messages: CherryUIMessage[], provider: string, model: string): Message[] {
  const dshMessages: Message[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const systemBlocks = message.parts
        .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
        .map((text) => ({ type: 'text' as const, text }))
      if (systemBlocks.length === 0) continue
      dshMessages.push(
        createMessage({
          role: 'system',
          content: systemBlocks,
          source: { kind: 'plugin', plugin: 'api-gateway' }
        })
      )
      continue
    }

    const { blocks, toolResults } = uiPartsToBlocks(message)
    if (blocks.length > 0) {
      if (message.role === 'assistant') {
        dshMessages.push(
          createAssistantMessage({
            content: blocks,
            source: { provider, model }
          }) satisfies AssistantMessage
        )
      } else {
        dshMessages.push(
          createUserMessage({
            content: blocks,
            source: { kind: 'plugin', plugin: 'api-gateway' }
          }) satisfies UserMessage
        )
      }
    } else if (message.parts.length > 0) {
      warnOnce('empty-message', 'a UIMessage lost all parts in mapping and was dropped')
    }
    for (const result of toolResults) {
      dshMessages.push(
        createToolResultMessage({
          callId: CallId(result.callId),
          content: [{ type: 'text', text: result.text }],
          isError: result.isError
        })
      )
    }
  }

  return dshMessages
}

/** OpenAI function tools（converters ToolSet）→ GenerateOptions.tools。裁掉的子字段：
 * execute（网关工具本就无 execute，客户端工具）；zod→JSON Schema 经 asSchema 规范化，
 * 失败兜底 {type:'object'}。 */
async function toolsToToolSchemas(tools: ToolSet | undefined): Promise<ToolSchema[] | undefined> {
  if (!tools) return undefined
  const schemas = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      let parameters: Record<string, unknown> = { type: 'object' }
      try {
        const jsonSchema = await asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema
        if (jsonSchema && typeof jsonSchema === 'object') parameters = jsonSchema as Record<string, unknown>
      } catch {
        // 规范化失败保留最小对象 schema：模型仍能收到工具声明（参数约束降级）。
      }
      return { name, description: tool.description ?? '', parameters }
    })
  )
  return schemas.length > 0 ? schemas : undefined
}

/**
 * dsh TokenUsage → GatewayUsageMetadata（adapters/interfaces 的 MessageStats 形状）。
 * dsh 计数不相交：inputTokens 是未命中缓存的输入，billed input = input + cacheRead +
 * cacheWrite——AI SDK 语义里 inputTokens 是总输入、cacheRead 是其明细，故三者先求和。
 */
function usageMetadata(usage: TokenUsage): {
  stats: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
} {
  const cachedInput = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return {
    stats: {
      totalTokens: usage.inputTokens + cachedInput + usage.outputTokens,
      inputTokens: usage.inputTokens + cachedInput,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { inputTokenDetails: { cacheReadTokens: usage.cacheReadTokens } }),
      ...(usage.reasoningTokens === undefined ? {} : { outputTokenDetails: { reasoningTokens: usage.reasoningTokens } })
    }
  }
}

/**
 * StreamChunk → UIMessageChunk 逐条映射（父代理已定映射表；text/reasoning 的
 * start/end 由 block-start/block-end 合成——单个适配器对裸 delta 已容错，但
 * 文本→工具→文本的交错输出需要块边界才是协议正确的 Anthropic SSE）。
 * tool-call-delta 增量被 block-end 的完整输入取代；replayState 引擎不消费。
 */
async function* mapStreamChunkStream(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<UIMessageChunk> {
  // dsh block index → UIMessageChunk 部件 id（同一块内的 delta 复用同一 id）。
  const partIds = new Map<number, string>()

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'text') {
          const id = `text-${chunk.index}`
          partIds.set(chunk.index, id)
          yield { type: 'text-start', id }
        } else if (chunk.blockType === 'reasoning') {
          const id = `reasoning-${chunk.index}`
          partIds.set(chunk.index, id)
          yield { type: 'reasoning-start', id }
        }
        break
      }
      case 'text-delta':
        yield { type: 'text-delta', id: partIds.get(chunk.index) ?? `text-${chunk.index}`, delta: chunk.text }
        break
      case 'reasoning-delta':
        yield {
          type: 'reasoning-delta',
          id: partIds.get(chunk.index) ?? `reasoning-${chunk.index}`,
          delta: chunk.text
        }
        break
      case 'block-end': {
        const block = chunk.block
        if (block.type === 'text') {
          yield { type: 'text-end', id: partIds.get(chunk.index) ?? `text-${chunk.index}` }
          partIds.delete(chunk.index)
        } else if (block.type === 'reasoning') {
          yield { type: 'reasoning-end', id: partIds.get(chunk.index) ?? `reasoning-${chunk.index}` }
          partIds.delete(chunk.index)
        } else if (block.type === 'tool-call') {
          let input: unknown
          try {
            input = JSON.parse(block.arguments)
          } catch {
            input = { raw: block.arguments }
            warnOnce('tool-args-json', 'tool-call arguments were not valid JSON; wrapped as {raw}')
          }
          yield { type: 'tool-input-available', toolCallId: block.id, toolName: block.name, input }
        } else {
          // image / 插件扩展块：网关 SSE 无对应语义，丢块（warnOnce 去重）。
          warnOnce(`block:${block.type}`, `StreamChunk block "${block.type}" has no UIMessageChunk equivalent`)
        }
        break
      }
      case 'usage':
        yield { type: 'message-metadata', messageMetadata: usageMetadata(chunk.usage) }
        break
      case 'finish': {
        const kind = chunk.reason.kind
        if (kind === 'stop' || kind === 'tool-calls') {
          yield { type: 'finish', finishReason: kind }
        } else if (kind === 'max-tokens') {
          yield { type: 'finish', finishReason: 'length' }
        } else {
          // aborted / error：不是正常完成——网关以 error chunk 收口（客户端断连时
          // 下游写入是无害 no-op；空闲超时由 proxyStream 的泵先行合成 504 帧）。
          const failure = 'failure' in chunk.reason ? chunk.reason.failure : undefined
          yield { type: 'error', errorText: failure?.message ?? kind }
        }
        return
      }
      default:
        break
    }
  }
}

/**
 * 网关流式引擎缝：一次 ctx.llm.stream 往返，产出 UIMessageChunk 流。
 * kernel 未 boot 时抛错（网关请求没有可用 provider 路由，无静默降级）。
 */
export function streamPrompt(
  provider: KernelProviderInput,
  model: string,
  messages: CherryUIMessage[],
  overrides: GatewayStreamOverrides = {}
): AsyncIterable<UIMessageChunk> {
  const kernel = getKernel()
  if (!kernel) throw new Error('kernel not booted: the API gateway requires the dsh kernel (ctx.llm)')

  const { leadingSystemTexts, rest } = splitLeadingSystem(messages)
  const system = [overrides.system, ...leadingSystemTexts].filter((part) => part && part.length > 0).join('\n\n')

  const options: GenerateOptions = {
    provider: provider.id,
    model,
    messages: uiMessagesToDshMessages(rest, provider.id, model),
    ...(system ? { system } : {}),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.temperature === undefined ? {} : { temperature: overrides.temperature }),
    ...(overrides.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }),
    ...(overrides.stop === undefined || overrides.stop.length === 0 ? {} : { stop: overrides.stop }),
    ...(overrides.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(overrides.reasoningEffort) })
  }

  // tools 转换是异步的（zod → JSON Schema），放生成器内部 await。
  return mapWithTools(kernel, options, overrides.tools)
}

async function* mapWithTools(
  kernel: NonNullable<ReturnType<typeof getKernel>>,
  options: GenerateOptions,
  tools: ToolSet | undefined
): AsyncGenerator<UIMessageChunk> {
  const schemas = await toolsToToolSchemas(tools)
  const effectiveOptions: GenerateOptions = schemas === undefined ? options : { ...options, tools: schemas }
  yield* mapStreamChunkStream(kernel.llm.stream(effectiveOptions))
}
