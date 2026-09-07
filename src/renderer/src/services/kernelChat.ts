import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 类型副作用导入：加载 dsh-session-title 对 SessionEventMap 的声明合并（session/title 事件）
import type {} from '@deepseek-ai/dsh-session-title'
import { loggerService } from '@logger'
import store from '@renderer/store'
import { updateTopic, updateTopicUpdatedAt } from '@renderer/store/assistants'
import { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Assistant, Model } from '@renderer/types'
import {
  AssistantMessageStatus,
  type MainTextMessageBlock,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType
} from '@renderer/types/newMessage'
import { providerReasoningCompat } from '@renderer/config/reasoningCompat'
import { renameAbortController } from '@renderer/utils/abortController'
import { createMainTextBlock, createThinkingBlock } from '@renderer/utils/messageUtils/create'
import { kernelReasoningEffortsForModel, kernelReasoningLevelFor } from '@renderer/utils/reasoningKernel'

const logger = loggerService.withContext('KernelChat')

// ---------------------------------------------------------------------------
// 渲染进程 ↔ dsh 内核的聊天桥。
// 职责：
//   1. 把现有聊天发送路径里的"网络调用"换成内核（topic-send）
//   2. 订阅内核 session 事件流，投影成 Cherry 的 Message/MessageBlock 进 Redux
//      —— UI 是内核的显示器，内核会话日志是权威数据源
// 约束：内核路径任何一步失败都记录日志并向上抛，由调用方走原有回退。
// ---------------------------------------------------------------------------

/** topicId → 等待内核回复的助手消息 stub id（sendMessage thunk 创建）。 */
const pendingStubs = new Map<string, string>()

/** 单个回合的投影状态。 */
interface StreamState {
  assistantMessageId: string
  turn: number
  step: number
  mainBlockId: string
  mainText: string
  thinkingBlockId?: string
  thinkingText: string
}

const streams = new Map<string, StreamState>()

// --- 分支锚点簿记（最小版，无 UI） ---
// 本地上送的 user 消息（uuid）在回执 user/message 事件到达前拿不到内核 seq；
// 这里按会话 FIFO 记录 "尚未回执的发送"，事件到达时把 seq 记到 uuid 上，供将来对该消息 fork。
const pendingUserIds = new Map<string, string[]>()
const liveUserSeq = new Map<string, number>() // key = `${topicId}\u0000${messageId}`

/** 发送前登记：该 user 消息即将以内核新事件落库（会话内 FIFO）。 */
function rememberPendingUser(topicId: string, userMessageId: string): void {
  const queue = pendingUserIds.get(topicId) ?? []
  queue.push(userMessageId)
  pendingUserIds.set(topicId, queue)
}

/** user/message 事件回执：把最早一条未回执发送的 seq 关联上，返回该本地消息 id（无则 undefined）。 */
function recordUserMessageSeq(topicId: string, seq: number): string | undefined {
  const queue = pendingUserIds.get(topicId)
  if (queue === undefined || queue.length === 0) return undefined
  const userMessageId = queue.shift() as string
  liveUserSeq.set(topicId + '\u0000' + userMessageId, seq)
  return userMessageId
}

export interface KernelAnchor {
  sessionId: string
  seq: number
}

/** 消息 → 内核锚点 (sessionId, seq)。
 * kernel-<session>-<seq> 形态直接解析；本地 uuid（尚未重载的内核消息）走回执登记表。
 */
export function kernelAnchorOf(topicId: string, message: Message): KernelAnchor | undefined {
  const id = message.id
  if (id.startsWith('kernel-')) {
    const body = id.slice('kernel-'.length)
    const dash = body.lastIndexOf('-')
    if (dash <= 0) return undefined
    const seqText = body.slice(dash + 1)
    if (!/^[0-9]+$/.test(seqText)) return undefined
    return { sessionId: body.slice(0, dash), seq: Number(seqText) }
  }
  const seq = liveUserSeq.get(topicId + '\u0000' + id)
  return seq === undefined ? undefined : { sessionId: topicId, seq }
}

/** 在内核把 source 会话按锚点 fork 成子分支（源会话原样保留）。返回子分支信息；锚点不可解析/失败返回 null。 */
export async function forkBranchToKernel(
  sourceTopicId: string,
  anchorMessage: Message
): Promise<{ id: string; name?: string; createdAt?: number; updatedAt?: number; parentTopicId?: string } | null> {
  const anchor = kernelAnchorOf(sourceTopicId, anchorMessage)
  if (anchor === undefined) {
    logger.warn('kernelChat: no kernel anchor for message ' + anchorMessage.id)
    return null
  }
  if (anchor.sessionId !== sourceTopicId) {
    logger.warn('kernelChat: anchor belongs to a different session, abort fork')
    return null
  }
  try {
    const { topic } = (await window.api.dshTopicFork(anchor.sessionId, anchor.seq)) as {
      topic: { id: string; name?: string; createdAt?: number; updatedAt?: number; parentTopicId?: string }
    }
    return topic
  } catch (error) {
    logger.error(
      'kernelChat: failed to fork topic ' + sourceTopicId,
      error instanceof Error ? error : new Error(String(error))
    )
    return null
  }
}

/** destroyTurns 结果的渲染侧类型（与内核 topics.ts DestroyTurnsResult 同构）。 */
export interface DestroyTurnsResponse {
  purgedTopics: string[]
  truncated: { id: string; fromSeq: number }[]
  focusTopicId: string | null
}

/** 消息级删除：受影响集合/物理/焦点全部由内核一次事务算完（kernel/topics.ts destroyTurns）。 */
export async function destroyTurnsInKernel(
  topicId: string,
  anchorUserSeqs: number[]
): Promise<DestroyTurnsResponse> {
  return (await window.api.dshTopicDestroyTurns(topicId, anchorUserSeqs)) as DestroyTurnsResponse
}

let bridgeInitialized = false

/** 应用启动时调用一次：订阅内核事件流。 */
export function initKernelBridge(): void {
  if (bridgeInitialized) return
  bridgeInitialized = true
  window.api.dshOnSessionEvent((payload) => {
    try {
      handleSessionEvent(payload as { topicId: string; event: SessionEvent })
    } catch (error) {
      logger.error(
        'kernelChat: failed to handle session event',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
  logger.info('kernelChat: bridge initialized')
}

/** 把渲染进程的 provider 配置同步进内核（应用启动与 provider 变更时调用）。 */
export async function syncProvidersToKernel(providers: unknown[]): Promise<void> {
  try {
    const enriched = (providers as Array<Record<string, unknown>>).map((provider) => {
      const models = (provider.models as Array<Record<string, unknown>> | undefined) ?? []
      return {
        ...provider,
        models: models.map((model) => {
          const reasoningEfforts = kernelReasoningEffortsForModel(model as Model)
          // 通用登记表：按 apiHost/provider id 命中第三方网关的思考协议（硅基流动等）
          const compat = providerReasoningCompat(provider, model as Model)
          if (reasoningEfforts === undefined && compat === undefined) return model
          return {
            ...model,
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
            ...(compat === undefined ? {} : { compat })
          }
        })
      }
    })
    await window.api.dshSyncProviders(enriched)
  } catch (error) {
    logger.error(
      'kernelChat: failed to sync providers to kernel',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/** 助手当前生效的思考档位（映射为内核档位；非推理模型/auto/default 返回 undefined）。 */
export function assistantReasoningLevel(assistant: Assistant): string | undefined {
  return kernelReasoningLevelFor(assistant.model, assistant.settings?.reasoning_effort)
}

/** 确保内核侧存在该话题的 agent/session（幂等）。 */
export async function ensureKernelTopic(topicId: string, assistant: Assistant): Promise<void> {
  const model = assistant.model
  if (model === undefined || model.provider === undefined) {
    throw new Error(`kernelChat: assistant "${assistant.id}" has no model/provider`)
  }
  await window.api.dshTopicCreate({
    id: topicId,
    provider: model.provider,
    model: model.id,
    maxTokens: assistant.settings?.maxTokens,
    systemPrompt: assistant.prompt,
    reasoningEffort: assistantReasoningLevel(assistant)
  })
}

/** 发送一条消息到内核；流式回复经由事件流投影回 Redux。 */
export async function sendToKernel(
  topicId: string,
  text: string,
  assistantMessageId: string,
  reasoningEffort?: string,
  userMessageId?: string
): Promise<void> {
  pendingStubs.set(topicId, assistantMessageId)
  if (userMessageId !== undefined) rememberPendingUser(topicId, userMessageId)
  try {
    await window.api.dshTopicSend(topicId, text, reasoningEffort)
  } catch (error) {
    pendingStubs.delete(topicId)
    throw error
  }
}

/**
 * 从内核会话日志还原一个话题的 Message/MessageBlock（打开话题的初始渲染用）。
 * 返回 null 表示内核不可用（未启动/无此话题），调用方应回退旧路径。
 */
export async function loadKernelTopicMessages(
  topicId: string
): Promise<{ messages: Message[]; blocks: MessageBlock[] } | null> {
  try {
    const { events } = await window.api.dshTopicEvents(topicId)
    return projectEventsToMessages(topicId, events as SessionEvent[])
  } catch (error) {
    logger.warn(
      `kernelChat: failed to load topic "${topicId}" from kernel`,
      error instanceof Error ? error : new Error(String(error))
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// 事件投影
// ---------------------------------------------------------------------------

function handleSessionEvent(payload: { topicId: string; event: SessionEvent }): void {
  const { topicId, event } = payload
  switch (event.type) {
    case 'user/message': {
      // 回执登记：本地 uuid user 消息 → 内核 seq（供以后对该消息 fork 用）
      const localUserId = recordUserMessageSeq(topicId, event.seq)
      // P3 消息 id 统一：回执到达即把本地 uuid 改写为 kernel-<topic>-<seq>（含块与 askId 引用）
      if (localUserId) {
        liveUserSeq.delete(topicId + '\u0000' + localUserId)
        remapMessageToKernelId(topicId, localUserId, event.seq)
      }
      break
    }
    case 'turn/start': {
      startTurn(topicId, event.data.turn)
      break
    }
    case 'assistant/chunk': {
      projectChunk(topicId, event.data.chunk)
      break
    }
    case 'assistant/message': {
      const stubId = pendingStubs.get(topicId)
      finalizeAssistantMessage(topicId, event.data)
      // 助手消息收尾后同样把本地 stub 改写为 kernel id，保证会话内不再残留 uuid 消息
      if (stubId) remapMessageToKernelId(topicId, stubId, event.seq)
      break
    }
    case 'turn/end': {
      finishTurn(topicId, event.data.reason)
      break
    }
    case 'session/title': {
      applyKernelTitle(topicId, event.data.title)
      break
    }
    default:
      break
  }
}

function startTurn(topicId: string, turn: number): void {
  const stubId = pendingStubs.get(topicId)
  if (stubId === undefined) return

  const mainBlock = createMainTextBlock(stubId, '', { status: MessageBlockStatus.STREAMING })
  streams.set(topicId, {
    assistantMessageId: stubId,
    turn,
    step: 0,
    mainBlockId: mainBlock.id,
    mainText: '',
    thinkingText: ''
  })
  store.dispatch(upsertManyBlocks([mainBlock]))
  store.dispatch(
    newMessagesActions.updateMessage({
      topicId,
      messageId: stubId,
      updates: { blocks: [mainBlock.id], status: AssistantMessageStatus.PROCESSING }
    })
  )
}

function projectChunk(topicId: string, chunk: StreamChunk): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  switch (chunk.type) {
    case 'text-delta': {
      state.mainText += chunk.text
      flushBlockUpdate(state.mainBlockId, { content: state.mainText })
      break
    }
    case 'reasoning-delta': {
      state.thinkingText += chunk.text
      if (state.thinkingBlockId === undefined) {
        const thinkingBlock = createThinkingBlock(state.assistantMessageId, '', {
          status: MessageBlockStatus.STREAMING
        })
        state.thinkingBlockId = thinkingBlock.id
        store.dispatch(upsertManyBlocks([thinkingBlock]))
        store.dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: state.assistantMessageId,
            updates: { blocks: [thinkingBlock.id, state.mainBlockId] }
          })
        )
      }
      if (state.thinkingBlockId !== undefined) {
        flushBlockUpdate(state.thinkingBlockId, { content: state.thinkingText })
      }
      break
    }
    case 'tool-call-delta':
      // MCP 已砍：工具调用块暂不渲染，仅记录
      logger.debug(`kernelChat: tool-call chunk ignored (${chunk.name ?? chunk.id})`)
      break
    default:
      break
  }
}

/** 块内容更新走 rAF 合并，避免高频 delta 刷爆渲染。 */
const blockFlushQueue = new Map<string, { timer: number; changes: Record<string, unknown> }>()
function flushBlockUpdate(blockId: string, changes: Partial<MessageBlock>): void {
  const existing = blockFlushQueue.get(blockId)
  if (existing !== undefined) {
    existing.changes = { ...existing.changes, ...changes }
    return
  }
  const entry = { timer: 0, changes: changes as Record<string, unknown> }
  blockFlushQueue.set(blockId, entry)
  entry.timer = window.requestAnimationFrame(() => {
    const current = blockFlushQueue.get(blockId)
    if (current !== undefined) {
      store.dispatch(updateOneBlock({ id: blockId, changes: current.changes as Partial<MessageBlock> }))
      blockFlushQueue.delete(blockId)
    }
  })
}

function finalizeAssistantMessage(
  topicId: string,
  data: {
    message: { content: { type: string; text?: string }[] }
    usage?: { inputTokens?: number; outputTokens?: number }
  }
): void {
  const state = streams.get(topicId)
  if (state === undefined) return

  const blocks: MessageBlock[] = []
  const blockIds: string[] = []

  for (const block of data.message.content) {
    if (block.type === 'text' && block.text !== undefined && block.text.length > 0) {
      const main = createMainTextBlock(state.assistantMessageId, block.text, { status: MessageBlockStatus.SUCCESS })
      blocks.push(main)
      blockIds.push(main.id)
    } else if (block.type === 'reasoning' && block.text !== undefined && block.text.length > 0) {
      const thinking = createThinkingBlock(state.assistantMessageId, block.text, { status: MessageBlockStatus.SUCCESS })
      blocks.push(thinking)
      blockIds.push(thinking.id)
    } else if (block.type === 'tool-call') {
      logger.debug('kernelChat: assistant tool-call block not rendered (MCP cut)')
    }
  }

  // 以最终块为准替换流式过程中的临时块
  if (state.mainBlockId !== undefined && !blockIds.includes(state.mainBlockId)) {
    store.dispatch(updateOneBlock({ id: state.mainBlockId, changes: { status: MessageBlockStatus.SUCCESS } }))
  }
  if (state.thinkingBlockId !== undefined) {
    store.dispatch(updateOneBlock({ id: state.thinkingBlockId, changes: { status: MessageBlockStatus.SUCCESS } }))
  }
  if (blocks.length > 0) {
    store.dispatch(upsertManyBlocks(blocks))
  }

  const updates: Partial<Message> = {
    status: AssistantMessageStatus.SUCCESS,
    blocks: blockIds.length > 0 ? blockIds : state.mainBlockId !== undefined ? [state.mainBlockId] : []
  }
  if (data.usage !== undefined) {
    const inputTokens = data.usage.inputTokens ?? 0
    const outputTokens = data.usage.outputTokens ?? 0
    updates.usage = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  }
  store.dispatch(newMessagesActions.updateMessage({ topicId, messageId: state.assistantMessageId, updates }))
  store.dispatch(updateTopicUpdatedAt({ topicId }))
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))

  streams.delete(topicId)
  pendingStubs.delete(topicId)
}

function finishTurn(topicId: string, reason: { kind: string; error?: { message: string; code: string } }): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  if (reason.kind === 'error') {
    logger.error(`kernelChat: turn failed for topic "${topicId}": ${reason.error?.message ?? 'unknown'}`)
    store.dispatch(updateOneBlock({ id: state.mainBlockId, changes: { status: MessageBlockStatus.ERROR } }))
    store.dispatch(
      newMessagesActions.updateMessage({
        topicId,
        messageId: state.assistantMessageId,
        updates: { status: AssistantMessageStatus.ERROR }
      })
    )
  } else if (reason.kind === 'aborted') {
    store.dispatch(updateOneBlock({ id: state.mainBlockId, changes: { status: MessageBlockStatus.PAUSED } }))
    store.dispatch(
      newMessagesActions.updateMessage({
        topicId,
        messageId: state.assistantMessageId,
        updates: { status: AssistantMessageStatus.PAUSED }
      })
    )
  }
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
  streams.delete(topicId)
  pendingStubs.delete(topicId)
}

function applyKernelTitle(topicId: string, title: string): void {
  if (typeof title !== 'string' || title.length === 0) return
  const state = store.getState()
  for (const assistant of state.assistants.assistants) {
    const topic = assistant.topics.find((t) => t.id === topicId)
    if (topic !== undefined) {
      store.dispatch(updateTopic({ assistantId: assistant.id, topic: { ...topic, name: title } }))
      return
    }
  }
}

// ---------------------------------------------------------------------------
// 历史还原：session 事件 → Cherry Message/MessageBlock
// ---------------------------------------------------------------------------

function projectEventsToMessages(
  topicId: string,
  events: SessionEvent[]
): { messages: Message[]; blocks: MessageBlock[] } {
  const messages: Message[] = []
  const blocks: MessageBlock[] = []
  let lastUserMessageId: string | undefined

  const assistantId = findAssistantIdForTopic(topicId)

  for (const event of events) {
    if (event.type === 'user/message') {
      const messageId = kernelMessageId(topicId, event.seq)
      lastUserMessageId = messageId
      const blockIds: string[] = []
      for (const content of event.data.content) {
        if (content.type === 'text' && content.text.length > 0) {
          const block = createMainTextBlock(messageId, content.text, { status: MessageBlockStatus.SUCCESS })
          blocks.push(block)
          blockIds.push(block.id)
        }
      }
      messages.push(
        createKernelMessage(messageId, topicId, assistantId, 'user', blockIds, {
          askId: messageId,
          status: 'success' as AssistantMessageStatus
        })
      )
    } else if (event.type === 'assistant/message') {
      const messageId = kernelMessageId(topicId, event.seq)
      const blockIds: string[] = []
      for (const content of event.data.message.content) {
        if (content.type === 'text' && content.text.length > 0) {
          const block = createMainTextBlock(messageId, content.text, { status: MessageBlockStatus.SUCCESS })
          blocks.push(block)
          blockIds.push(block.id)
        } else if (content.type === 'reasoning' && content.text.length > 0) {
          const block = createThinkingBlock(messageId, content.text, { status: MessageBlockStatus.SUCCESS })
          blocks.push(block)
          blockIds.push(block.id)
        }
      }
      // 回填生成该消息的模型身份（头像/显示名/重新生成都依赖 modelId/model）。
      // source 类型上必填，但 SQLite 旧行或坏行可能缺失：缺了只退化为无头像，不让整个话题投影失败
      const source = event.data.message.source
      const modelFields: Partial<Message> =
        source !== undefined && source.model !== undefined
          ? { modelId: source.model, model: { id: source.model, provider: source.provider } as Model }
          : {}
      messages.push(
        createKernelMessage(messageId, topicId, assistantId, 'assistant', blockIds, {
          askId: lastUserMessageId,
          ...modelFields,
          status: 'success' as AssistantMessageStatus
        })
      )
    }
  }

  return { messages, blocks }
}

function kernelMessageId(topicId: string, seq: number): string {
  return `kernel-${topicId}-${seq}`
}

/** P3 消息 id 统一：把本地 uuid 消息（user 回执/assistant 收尾）改写为 kernel-<topic>-<seq>，
 * 同步修正其块的 messageId 与 reducer 内 askId 引用；之后删除/重发锚点可直接从 id 解析。 */
function remapMessageToKernelId(topicId: string, localId: string, seq: number): void {
  if (!localId || localId.startsWith('kernel-')) return
  const newId = kernelMessageId(topicId, seq)
  const existing = store.getState().messages.entities[localId]
  const blockIds = existing?.blocks ?? []
  // 中止键随消息 id 改写迁移（user 消息 uuid → kernel id），否则停止按钮按新 askId 查不到注册
  if (existing?.role === 'user') renameAbortController(localId, newId)
  store.dispatch(newMessagesActions.replaceMessageId({ topicId, oldId: localId, newId }))
  for (const blockId of blockIds) {
    store.dispatch(updateOneBlock({ id: blockId, changes: { messageId: newId } }))
  }
}

function createKernelMessage(
  id: string,
  topicId: string,
  assistantId: string,
  role: 'user' | 'assistant',
  blocks: string[],
  overrides: Partial<Message>
): Message {
  return {
    id,
    role,
    assistantId,
    topicId,
    createdAt: new Date().toISOString(),
    status: role === 'user' ? ('success' as AssistantMessageStatus) : ('success' as AssistantMessageStatus),
    blocks,
    ...overrides
  }
}

function findAssistantIdForTopic(topicId: string): string {
  const state = store.getState()
  for (const assistant of state.assistants.assistants) {
    if (assistant.topics.some((t) => t.id === topicId)) {
      return assistant.id
    }
  }
  return 'kernel'
}

/** 从用户消息块中提取纯文本（发送到内核用）。 */
export function extractTextFromUserMessage(message: Message): string {
  const state = store.getState()
  const blockIds = message.blocks ?? []
  const texts: string[] = []
  for (const blockId of blockIds) {
    const block = state.messageBlocks.entities[blockId]
    if (block !== undefined && block.type === MessageBlockType.MAIN_TEXT) {
      texts.push((block as MainTextMessageBlock).content)
    }
  }
  return texts.join('\n')
}
