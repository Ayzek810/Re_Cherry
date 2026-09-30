/**
 * 全局记忆抽取管线（v0.4.7 全局记忆接线，V1 MemoryProcessor 同构裁剪）。
 *
 * 形态（与 V1 三点对齐、两点裁剪）：
 * - extractFacts：回合结束后把最近一轮对话交给记忆模型（memoryConfig.llmModel，经
 *   fetchGenerate/lightComplete 轻通路）抽事实，提示词 = memory-prompts.ts 的
 *   factExtractionPrompt（用户自定义 customFactExtractionPrompt 优先）；
 * - updateMemories：与既有记忆差分（ADD/UPDATE/DELETE/NONE，updateMemorySystemPrompt），
 *   落库走渲染层 MemoryService（window.api.memory.* → 主进程 libsql）；
 * - 裁剪①：V1 用 keyv 以 lastMessageId 缓存"检索结果当既有记忆"，跨件耦合且搜索
 *   未发生时差分退化为全 ADD——fork 改为差分前直接按用户消息文本检索一次候选
 *   （limit 10），与 MemorySearchTool 是否被调用解耦；
 * - 裁剪②：V1 在 onRequestEnd 对整段请求历史抽取——token 无界。fork 只取最近一轮
 *   （用户消息 + 助手回复），这正是"记住刚才聊了什么"的本意；
 * - 裁剪③：无 zod/jaison 依赖（fork 未声明），手写窄化校验（形状不符 = 丢弃，如实记日志）。
 *
 * 触发点：kernelChat turn/end（成功回合），与 autoNameKernelTopic 同判例——
 * 后台 fire-and-forget、失败只记日志不弹 toast（后台自动动作不骚扰，见 topicNaming.ts）。
 * 全部门：全局记忆开关（store/memory.globalMemoryEnabled）&& assistant.enableMemory &&
 * 已配置记忆模型（memoryConfig.llmModel）。
 */
import { loggerService } from '@logger'
import { fetchGenerate } from '@renderer/services/ApiService'
import MemoryService from '@renderer/services/MemoryService'
import store from '@renderer/store'
import { selectGlobalMemoryEnabled, selectMemoryConfig } from '@renderer/store/memory'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Model } from '@renderer/types'
import { factExtractionPrompt, updateMemorySystemPrompt } from '@renderer/utils/memory-prompts'
import { findMainTextBlocks } from '@renderer/utils/messageUtils/find'

const logger = loggerService.withContext('MemoryProcessor')

/** 同一话题同时只跑一次（topicNaming 去重锁同款）。 */
const inflight = new Set<string>()

const MAX_FACTS = 20
const MAX_FACT_LENGTH = 500

/** 从模型回复中截取首个 JSON 块（容忍 ```json 围栏与前后缀文本）。 */
export function extractJsonBlock(text: string): string | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter((index) => index >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const close = cleaned[start] === '{' ? '}' : ']'
  const end = cleaned.lastIndexOf(close)
  if (end <= start) return undefined
  return cleaned.slice(start, end + 1)
}

/**
 * 解析事实抽取回复（V1 FactRetrievalSchema 的手写窄化替代）。
 * 接受 {"facts": [...]} 或裸数组；仅保留非空字符串，截 20 条/条 500 字。
 */
export function parseFactsFromResponse(response: string): string[] {
  const block = extractJsonBlock(response)
  if (block === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    logger.warn('memoryProcessor: fact extraction response is not valid JSON')
    return []
  }
  const raw = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown })?.facts
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, MAX_FACT_LENGTH))
    .slice(0, MAX_FACTS)
}

export interface MemoryUpdateOp {
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
  id: string
  text: string
  oldMemory?: string
}

/**
 * 解析记忆差分回复（V1 MemoryUpdateSchema 的手写窄化替代）。
 * 接受裸数组或 {"memory": [...]}；event 非法/id 缺失的条目丢弃并记日志。
 */
export function parseMemoryOpsFromResponse(response: string): MemoryUpdateOp[] {
  const block = extractJsonBlock(response)
  if (block === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    logger.warn('memoryProcessor: memory update response is not valid JSON')
    return []
  }
  const raw = Array.isArray(parsed) ? parsed : (parsed as { memory?: unknown })?.memory
  if (!Array.isArray(raw)) return []
  const allowed = new Set(['ADD', 'UPDATE', 'DELETE', 'NONE'])
  const ops: MemoryUpdateOp[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as { event?: unknown; id?: unknown; text?: unknown; old_memory?: unknown }
    if (typeof candidate.event !== 'string' || !allowed.has(candidate.event)) {
      logger.warn(`memoryProcessor: dropping memory op with unknown event "${String(candidate.event)}"`)
      continue
    }
    if (typeof candidate.text !== 'string') {
      logger.warn('memoryProcessor: dropping memory op without text')
      continue
    }
    if ((candidate.event === 'UPDATE' || candidate.event === 'DELETE') && typeof candidate.id !== 'string') {
      logger.warn(`memoryProcessor: dropping ${candidate.event} op without id`)
      continue
    }
    ops.push({
      event: candidate.event as MemoryUpdateOp['event'],
      id: typeof candidate.id === 'string' ? candidate.id : '',
      text: candidate.text,
      oldMemory: typeof candidate.old_memory === 'string' ? candidate.old_memory : undefined
    })
  }
  return ops
}

function buildFactRetrievalUserPrompt(parsedMessages: string): string {
  return `Following is a conversation between the user and the assistant. Extract relevant facts and preferences ABOUT THE USER from this conversation.
Conversation:
${parsedMessages}`
}

async function extractFacts(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: Model,
  customPrompt: string | undefined
): Promise<string[]> {
  const parsedMessages = messages.map((msg) => `${msg.role}: ${msg.content}`).join('\n')
  const response = await fetchGenerate({
    prompt: customPrompt || factExtractionPrompt,
    content: buildFactRetrievalUserPrompt(parsedMessages),
    model
  })
  if (!response || response.trim().length === 0) return []
  return parseFactsFromResponse(response)
}

/** 差分候选既有记忆：直接按用户消息文本检索（见头部裁剪①）。
 * 渲染层 MemoryService 已自行处理 user 作用域与错误吞并（失败 = 空结果 + 日志），
 * 这里只消费 results。 */
async function listCandidateMemories(queryHint: string) {
  const service = MemoryService.getInstance()
  const found = await service.search(queryHint, { limit: 10 })
  return found.results ?? []
}

async function updateMemories(
  facts: string[],
  config: { model: Model; assistantId: string; customUpdatePrompt?: string },
  queryHint: string
): Promise<number> {
  if (facts.length === 0) return 0
  const service = MemoryService.getInstance()

  // user 作用域由渲染层 MemoryService 实例自行接管（currentUserId），管线不重复上行。
  const existing = await listCandidateMemories(queryHint)
  let ops: MemoryUpdateOp[]
  if (existing.length === 0) {
    ops = facts.map((fact) => ({ event: 'ADD' as const, id: '', text: fact }))
  } else {
    const oldMemoryJson = JSON.stringify(
      existing.map((item) => ({ id: item.id, text: item.memory })),
      null,
      2
    )
    const response = await fetchGenerate({
      prompt: config.customUpdatePrompt || updateMemorySystemPrompt,
      content: `Old Memory:\n${oldMemoryJson}\n\nRetrieved facts: ${JSON.stringify(facts)}`,
      model: config.model
    })
    if (!response || response.trim().length === 0) return 0
    ops = parseMemoryOpsFromResponse(response)
    if (ops.length === 0) return 0
  }

  let applied = 0
  for (const op of ops) {
    try {
      if (op.event === 'ADD') {
        await service.add(op.text, { agentId: config.assistantId })
      } else if (op.event === 'UPDATE') {
        const target = existing.find((item) => item.id === op.id)
        if (target !== undefined) {
          await service.update(op.id, op.text, { agentId: config.assistantId, oldMemory: op.oldMemory })
        }
      } else if (op.event === 'DELETE') {
        await service.delete(op.id)
      } else {
        continue
      }
      applied += 1
    } catch (error) {
      logger.error(`memoryProcessor: failed to apply ${op.event} op:`, error as Error)
    }
  }
  return applied
}

/** 跨助手按 id 找话题行（topicNaming 同款：历史数据可能多持有，全查）。 */
function findTopicRow(topicId: string) {
  for (const assistant of store.getState().assistants.assistants) {
    const row = (assistant.topics ?? []).find((topic) => topic.id === topicId)
    if (row !== undefined) return { row, assistant }
  }
  return undefined
}

function messageMainText(message: ReturnType<typeof selectMessagesForTopic>[number] | undefined): string {
  if (message === undefined) return ''
  return findMainTextBlocks(message)
    .map((block) => block.content)
    .join('\n\n')
    .trim()
}

/**
 * 回合成功结束后的全局记忆抽取入口（kernelChat turn/end 触发，fire-and-forget）。
 * 门（全过才抽取）：① 全局记忆开关；② assistant.enableMemory；③ 已配置记忆模型；
 * ④ 最近一轮用户消息与助手回复都有正文。失败只记日志（后台自动动作不骚扰）。
 */
export async function maybeProcessConversationMemory(topicId: string): Promise<void> {
  if (inflight.has(topicId)) return
  inflight.add(topicId)
  try {
    const state = store.getState()
    if (!selectGlobalMemoryEnabled(state)) return
    const found = findTopicRow(topicId)
    if (found === undefined) return
    const { assistant } = found
    if (assistant.enableMemory !== true) return

    const memoryConfig = selectMemoryConfig(state)
    if (memoryConfig.llmModel === undefined) {
      logger.debug('memoryProcessor: no memory llm model configured, skip extraction')
      return
    }

    const messages = selectMessagesForTopic(state, topicId)
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    const userText = messageMainText(lastUser)
    const assistantText = messageMainText(lastAssistant)
    if (userText.length === 0 || assistantText.length === 0) return

    const facts = await extractFacts(
      [
        { role: 'user' as const, content: userText },
        { role: 'assistant' as const, content: assistantText }
      ],
      memoryConfig.llmModel,
      memoryConfig.customFactExtractionPrompt
    )
    if (facts.length === 0) {
      logger.debug('memoryProcessor: no facts extracted from the latest turn')
      return
    }
    const applied = await updateMemories(
      facts,
      {
        model: memoryConfig.llmModel,
        assistantId: assistant.id,
        customUpdatePrompt: memoryConfig.customUpdateMemoryPrompt
      },
      userText
    )
    logger.info(`memoryProcessor: topic ${topicId} extracted ${facts.length} fact(s), ${applied} op(s) applied`)
  } catch (error) {
    // 不抛出错误，避免影响主流程（V1 storeConversationMemory 同判例）
    logger.error('memoryProcessor: background memory processing failed:', error as Error)
  } finally {
    inflight.delete(topicId)
  }
}
