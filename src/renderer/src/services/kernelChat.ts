import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 类型副作用导入：加载 dsh-session-title 对 SessionEventMap 的声明合并（session/title 事件）
import type {} from '@deepseek-ai/dsh-session-title'
import { loggerService } from '@logger'
import store from '@renderer/store'
import { updateTopic, updateTopicUpdatedAt } from '@renderer/store/assistants'
import { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { toolPermissionsActions } from '@renderer/store/toolPermissions'
import { userQuestionsActions, type UserQuestionEntry } from '@renderer/store/userQuestions'
import type { Assistant, Model } from '@renderer/types'
import {
  AssistantMessageStatus,
  type MainTextMessageBlock,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType,
  type ToolMessageBlock
} from '@renderer/types/newMessage'
import { providerReasoningCompat } from '@renderer/config/reasoningCompat'
import { renameAbortController } from '@renderer/utils/abortController'
import { createMainTextBlock, createThinkingBlock, createToolBlock } from '@renderer/utils/messageUtils/create'
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

/** 单个回合（turn）的投影状态：一轮 = 一条回答（B8），轮内多 step 的说话/工具块都归并进同一条消息。 */
interface TurnState {
  assistantMessageId: string
  turn: number
  /** 当前 step（事件自带 step；换 step 即新开一段说话块）。 */
  currentStep?: number
  /** 当前 step 的流式说话块（text / reasoning）。 */
  mainBlockId?: string
  mainText: string
  thinkingBlockId?: string
  thinkingText: string
  /** 本轮块序（消息 blocks 列表的权威；按事件顺序追加，assistant/message 时替换回当前 step 的流式块）。 */
  blockIds: string[]
  /** callId → 工具块（tool/result 按 callId 回填同一块）。 */
  toolBlocks: Map<string, ToolMessageBlock>
  /** 跨 step 累计的 token 用量（每条 assistant/message 携带其 step 的用量）。 */
  usage: { inputTokens: number; outputTokens: number }
  /** 是否已把 stub uuid 改写为 kernel id（在本轮第一条 assistant/message 时发生，与其后历史还原一致）。 */
  sawAssistantMessage: boolean
}

const streams = new Map<string, TurnState>()

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

/** 应用启动时调用一次：订阅内核事件流与审批/问答请求帧。 */
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
  // 审批请求帧 → toolPermissions 状态机（工具卡按 callId 挂上 允许/拒绝 按钮）
  window.api.dshOnApprovalRequest((payload) => {
    try {
      const request = payload as {
        requestId: string
        topicId: string
        toolName: string
        callId?: string
        reason?: string
      }
      store.dispatch(
        toolPermissionsActions.requestReceived({
          requestId: request.requestId,
          toolName: request.toolName,
          toolId: request.callId ?? request.requestId,
          toolCallId: request.callId ?? request.requestId,
          topicId: request.topicId,
          description: request.reason,
          requiresPermissions: true,
          input: {},
          inputPreview: request.reason ?? '',
          createdAt: Date.now(),
          suggestions: []
        })
      )
    } catch (error) {
      logger.error(
        'kernelChat: failed to handle approval request',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
  // 问答请求帧 → userQuestions 状态机（ask_user_question 卡片内作答）
  window.api.dshOnQuestionRequest((payload) => {
    try {
      store.dispatch(userQuestionsActions.requestReceived(payload as UserQuestionEntry))
    } catch (error) {
      logger.error(
        'kernelChat: failed to handle question request',
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

/** 确保内核侧存在该话题的 agent/session（幂等）。工作模式不进建册输入——它是渲染层话题开关，随发送参数生效。 */
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
    reasoningEffort: assistantReasoningLevel(assistant),
    ...(assistant.workMode?.workingDir !== undefined && assistant.workMode.workingDir.length > 0
      ? { workingDir: assistant.workMode.workingDir }
      : {})
  })
}

/** 发送一条消息到内核；流式回复经由事件流投影回 Redux。工具面（内置/外置）与权限档位随发送参数生效（拨动下一轮生效）。 */
export async function sendToKernel(
  topicId: string,
  text: string,
  assistantMessageId: string,
  userMessageId?: string,
  options?: {
    reasoningEffort?: string
    builtinTools?: string[]
    externalTools?: string[]
    tier?: string
  }
): Promise<void> {
  pendingStubs.set(topicId, assistantMessageId)
  if (userMessageId !== undefined) rememberPendingUser(topicId, userMessageId)
  try {
    await window.api.dshTopicSend(topicId, text, options)
  } catch (error) {
    pendingStubs.delete(topicId)
    throw error
  }
}

/**
 * 从内核会话日志还原一个话题的 Message/MessageBlock（打开话题的初始渲染用）。
 * 按"轮"归并（B8：一轮 = 一条回答）：turn 内所有 assistant/message（多 step）的说话块
 * 顺序追加进同一条回答消息；tool/call + tool/result 按 callId 配对产出统一工具块。
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
      // 内核注入的插件源消息（RuntimeContextProjection 的工具面快照、审批档位变更等）
      // 不是用户发言：不参与回执配对（否则会消耗 FIFO 队列里真实发送的配对名额，把
      // 本地用户消息的回执 seq 记到注入事件上，fork 锚点随之错乱——分支控制混乱的根因
      // 之一），也不投影。user/message 事件的 data 就是消息本体（source 直接挂 data 上）。
      if (event.data.source?.kind === 'plugin') {
        break
      }
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
      projectChunk(topicId, event.data.step, event.data.chunk)
      break
    }
    case 'assistant/message': {
      // 每 step 一条 assistant/message：只收尾该 step 的块，回合状态保留到 turn/end（多 step 归并不丢内容）
      finalizeStep(topicId, event)
      break
    }
    case 'tool/call': {
      projectToolCall(topicId, event)
      break
    }
    case 'tool/result': {
      projectToolResult(topicId, event)
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
    mainBlockId: mainBlock.id,
    mainText: '',
    thinkingText: '',
    blockIds: [mainBlock.id],
    toolBlocks: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    sawAssistantMessage: false
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

/** 把本轮的块序列同步回消息（消息 blocks 列表的唯一写入口，保证 说话→工具→说话 的事件顺序）。 */
function syncMessageBlocks(topicId: string, state: TurnState): void {
  store.dispatch(
    newMessagesActions.updateMessage({
      topicId,
      messageId: state.assistantMessageId,
      updates: { blocks: [...state.blockIds] }
    })
  )
}

function projectChunk(topicId: string, step: number, chunk: StreamChunk): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  // 换 step：上一段说话已由 assistant/message 收尾，本段新开流式块。
  // currentStep 未定 = 首个 step，沿用 startTurn 建好的初始块。
  if (state.currentStep !== undefined && state.currentStep !== step) {
    state.mainBlockId = undefined
    state.mainText = ''
    state.thinkingBlockId = undefined
    state.thinkingText = ''
  }
  state.currentStep = step
  switch (chunk.type) {
    case 'text-delta': {
      if (state.mainBlockId === undefined) {
        const mainBlock = createMainTextBlock(state.assistantMessageId, '', {
          status: MessageBlockStatus.STREAMING
        })
        state.mainBlockId = mainBlock.id
        state.blockIds.push(mainBlock.id)
        store.dispatch(upsertManyBlocks([mainBlock]))
        syncMessageBlocks(topicId, state)
      }
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
        // 思考块置于本段文本块之前（沿用现有展示顺序）
        const mainIndex = state.mainBlockId !== undefined ? state.blockIds.indexOf(state.mainBlockId) : -1
        if (mainIndex >= 0) {
          state.blockIds.splice(mainIndex, 0, thinkingBlock.id)
        } else {
          state.blockIds.push(thinkingBlock.id)
        }
        store.dispatch(upsertManyBlocks([thinkingBlock]))
        syncMessageBlocks(topicId, state)
      }
      if (state.thinkingBlockId !== undefined) {
        flushBlockUpdate(state.thinkingBlockId, { content: state.thinkingText })
      }
      break
    }
    case 'tool-call-delta':
      // 工具调用块在 tool/call 事件落盘时创建（参数以最终 JSON 为准），流式 delta 不投影
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

/**
 * 收尾一个 step：以最终内容替换该 step 的流式说话块、累计 usage。
 * 回合状态保留（不删 streams / pendingStubs）——同一轮的后续 step 继续往同一条消息归并，
 * 直到 turn/end 才整体收尾。这是"修掉直播丢内容"的关键（B8：一轮 = 一条回答）。
 */
function finalizeStep(
  topicId: string,
  event: Extract<SessionEvent, { type: 'assistant/message' }>
): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const data = event.data

  // 本轮第一条 assistant/message：把 stub uuid 改写为 kernel-<topic>-<seq>（块与引用同步改写）。
  // canonical seq = 本轮第一条 assistant/message（含无文本的纯工具 step），与历史还原和 replySeqs 对齐。
  if (!state.sawAssistantMessage) {
    state.sawAssistantMessage = true
    remapMessageToKernelId(topicId, state.assistantMessageId, event.seq)
    state.assistantMessageId = kernelMessageId(topicId, event.seq)
  }

  // 最终说话块（tool-call 块由 tool/call 事件负责，不在这里产出，避免双卡）
  const finalBlockIds: string[] = []
  const finalBlocks: MessageBlock[] = []
  for (const block of data.message.content) {
    if (block.type === 'text' && block.text !== undefined && block.text.length > 0) {
      const main = createMainTextBlock(state.assistantMessageId, block.text, { status: MessageBlockStatus.SUCCESS })
      finalBlocks.push(main)
      finalBlockIds.push(main.id)
    } else if (block.type === 'reasoning' && block.text !== undefined && block.text.length > 0) {
      const thinking = createThinkingBlock(state.assistantMessageId, block.text, { status: MessageBlockStatus.SUCCESS })
      finalBlocks.push(thinking)
      finalBlockIds.push(thinking.id)
    }
  }

  // 从块序中摘掉当前 step 的流式块，把最终块插回原位
  const streamedIds = [state.thinkingBlockId, state.mainBlockId].filter((id): id is string => id !== undefined)
  if (streamedIds.length > 0) {
    const firstIndex = state.blockIds.findIndex((id) => streamedIds.includes(id))
    state.blockIds = state.blockIds.filter((id) => !streamedIds.includes(id))
    const insertAt = firstIndex >= 0 ? Math.min(firstIndex, state.blockIds.length) : state.blockIds.length
    state.blockIds.splice(insertAt, 0, ...finalBlockIds)
  } else if (finalBlockIds.length > 0) {
    state.blockIds.push(...finalBlockIds)
  }
  if (finalBlocks.length > 0) {
    store.dispatch(upsertManyBlocks(finalBlocks))
  }
  // 被替换的流式块标记终态（消息 blocks 已不含它们）
  for (const id of streamedIds) {
    store.dispatch(updateOneBlock({ id, changes: { status: MessageBlockStatus.SUCCESS } }))
  }

  // 累计 token 用量（每条 assistant/message 携带其 step 的用量，turn/end 时写入消息）
  if (data.usage !== undefined) {
    state.usage.inputTokens += data.usage.inputTokens ?? 0
    state.usage.outputTokens += data.usage.outputTokens ?? 0
  }

  // 重置说话块游标：下一段说话（下一个 step）新开块
  state.mainBlockId = undefined
  state.mainText = ''
  state.thinkingBlockId = undefined
  state.thinkingText = ''

  syncMessageBlocks(topicId, state)
}

/** 工具调用开始：建统一工具块（status=PROCESSING），按事件顺序追加进本轮块序。 */
function projectToolCall(topicId: string, event: Extract<SessionEvent, { type: 'tool/call' }>): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  let parsedArguments: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(event.data.arguments) as unknown
    if (parsed !== null && typeof parsed === 'object') parsedArguments = parsed as Record<string, unknown>
  } catch {
    parsedArguments = undefined
  }
  const block = createToolBlock(state.assistantMessageId, event.data.callId, {
    toolName: event.data.name,
    ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
    metadata: { rawArguments: event.data.arguments }
  })
  state.toolBlocks.set(event.data.callId, block)
  state.blockIds.push(block.id)
  store.dispatch(upsertManyBlocks([block]))
  syncMessageBlocks(topicId, state)
}

/** 工具调用结束：按 callId 回填同一块（结果文本 + 成功/失败）。 */
function projectToolResult(topicId: string, event: Extract<SessionEvent, { type: 'tool/result' }>): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const resultBlock = event.data.message?.content?.[0]
  if (resultBlock === undefined) return
  const toolBlock = state.toolBlocks.get(resultBlock.toolCallId)
  if (toolBlock === undefined) {
    logger.warn(`kernelChat: tool result without a tracked call (${resultBlock.toolCallId}) in topic "${topicId}"`)
    return
  }
  const text = (resultBlock.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
  const failed = resultBlock.isError === true || event.data.error !== undefined
  store.dispatch(
    updateOneBlock({
      id: toolBlock.id,
      changes: {
        content: text,
        status: failed ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
      }
    })
  )
  // 工具出结果即该调用的审批生命周期结束（'invoking' 条目随之摘除）
  store.dispatch(toolPermissionsActions.removeByToolCallId({ toolCallId: resultBlock.toolCallId }))
}

function finishTurn(topicId: string, reason: { kind: string; error?: { message: string; code: string } }): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const failed = reason.kind === 'error'
  const aborted = reason.kind === 'aborted'
  if (failed) {
    logger.error(`kernelChat: turn failed for topic "${topicId}": ${reason.error?.message ?? 'unknown'}`)
  }
  // 只收尾仍处于流式/进行中的块（已终态的块保持其成功/失败原样）
  const settleStatus = failed ? MessageBlockStatus.ERROR : aborted ? MessageBlockStatus.PAUSED : MessageBlockStatus.SUCCESS
  const entities = store.getState().messageBlocks.entities
  for (const blockId of state.blockIds) {
    const block = entities[blockId]
    if (
      block !== undefined &&
      (block.status === MessageBlockStatus.STREAMING || block.status === MessageBlockStatus.PROCESSING)
    ) {
      store.dispatch(updateOneBlock({ id: blockId, changes: { status: settleStatus } }))
    }
  }
  const updates: Partial<Message> = {
    status: failed
      ? AssistantMessageStatus.ERROR
      : aborted
        ? AssistantMessageStatus.PAUSED
        : AssistantMessageStatus.SUCCESS
  }
  if (state.usage.inputTokens > 0 || state.usage.outputTokens > 0) {
    updates.usage = {
      prompt_tokens: state.usage.inputTokens,
      completion_tokens: state.usage.outputTokens,
      total_tokens: state.usage.inputTokens + state.usage.outputTokens
    }
  }
  store.dispatch(newMessagesActions.updateMessage({ topicId, messageId: state.assistantMessageId, updates }))
  store.dispatch(updateTopicUpdatedAt({ topicId }))
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
  // 兜底清理：回合结束（含错误/中断）时该话题不应再有未决审批/问答
  store.dispatch(toolPermissionsActions.clearByTopic({ topicId }))
  store.dispatch(userQuestionsActions.clearByTopic({ topicId }))
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
  const assistantId = findAssistantIdForTopic(topicId)

  let lastUserMessageId: string | undefined
  // 当前轮的合并回答：turn 内所有 assistant/message（多 step）都归并进这一条消息
  let reply: {
    messageId: string
    message: Message
    blockIds: string[]
    usage: { inputTokens: number; outputTokens: number }
    toolBlocks: Map<string, ToolMessageBlock>
  } | null = null

  const closeReply = (): void => {
    if (reply === null) return
    reply.message.blocks = reply.blockIds
    if (reply.usage.inputTokens > 0 || reply.usage.outputTokens > 0) {
      reply.message.usage = {
        prompt_tokens: reply.usage.inputTokens,
        completion_tokens: reply.usage.outputTokens,
        total_tokens: reply.usage.inputTokens + reply.usage.outputTokens
      }
    }
    reply = null
  }

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        // 内核注入的插件源消息（RuntimeContextProjection 的工具面快照、审批档位变更等）
        // 不是用户发言——不投影为聊天气泡（user/message 事件的 data 就是消息本体，source
        // 直接挂 data 上，没有 .message 包裹——assistant/message 才有）。刻意不 closeReply：
        // 注入只出现在 step 边界（审批档位变更在轮内、快照在 user 后 assistant 前且彼时
        // reply 已被真实 user 消息 close），同轮的 step 间切断会把一轮回答误拆成两条。
        if (event.data.source?.kind === 'plugin') break
        closeReply()
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
        break
      }
      case 'assistant/message': {
        // 回填生成该消息的模型身份（头像/显示名/重新生成都依赖 modelId/model）。
        // source 类型上必填，但 SQLite 旧行或坏行可能缺失：缺了只退化为无头像，不让整个话题投影失败
        const source = event.data.message.source
        const modelFields: Partial<Message> =
          source !== undefined && source.model !== undefined
            ? { modelId: source.model, model: { id: source.model, provider: source.provider } as Model }
            : {}
        if (reply === null) {
          // 本轮第一条 assistant/message：建立合并后的回答消息。
          // canonical id = 本事件 seq（与直播路径的 remap 时机和 replySeqs 一致）
          const messageId = kernelMessageId(topicId, event.seq)
          const message = createKernelMessage(messageId, topicId, assistantId, 'assistant', [], {
            askId: lastUserMessageId,
            ...modelFields,
            status: 'success' as AssistantMessageStatus
          })
          messages.push(message)
          reply = {
            messageId,
            message,
            blockIds: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            toolBlocks: new Map()
          }
        }
        // 说话块顺序追加；tool-call 块由 tool/call + tool/result 事件负责（避免双卡）
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text !== undefined && block.text.length > 0) {
            const main = createMainTextBlock(reply.messageId, block.text, { status: MessageBlockStatus.SUCCESS })
            blocks.push(main)
            reply.blockIds.push(main.id)
          } else if (block.type === 'reasoning' && block.text !== undefined && block.text.length > 0) {
            const thinking = createThinkingBlock(reply.messageId, block.text, { status: MessageBlockStatus.SUCCESS })
            blocks.push(thinking)
            reply.blockIds.push(thinking.id)
          }
        }
        if (event.data.usage !== undefined) {
          reply.usage.inputTokens += event.data.usage.inputTokens ?? 0
          reply.usage.outputTokens += event.data.usage.outputTokens ?? 0
        }
        break
      }
      case 'tool/call': {
        if (reply === null) {
          logger.warn(`kernelChat: tool/call before any assistant message in topic "${topicId}" (seq ${event.seq})`)
          break
        }
        let parsedArguments: Record<string, unknown> | undefined
        try {
          const parsed = JSON.parse(event.data.arguments) as unknown
          if (parsed !== null && typeof parsed === 'object') parsedArguments = parsed as Record<string, unknown>
        } catch {
          parsedArguments = undefined
        }
        const toolBlock = createToolBlock(reply.messageId, event.data.callId, {
          toolName: event.data.name,
          ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
          metadata: { rawArguments: event.data.arguments }
        })
        blocks.push(toolBlock)
        reply.blockIds.push(toolBlock.id)
        reply.toolBlocks.set(event.data.callId, toolBlock)
        break
      }
      case 'tool/result': {
        if (reply === null) break
        const resultBlock = event.data.message?.content?.[0]
        if (resultBlock === undefined) break
        const toolBlock = reply.toolBlocks.get(resultBlock.toolCallId)
        if (toolBlock === undefined) {
          logger.warn(`kernelChat: tool result without a tracked call (${resultBlock.toolCallId}) in topic "${topicId}"`)
          break
        }
        const text = (resultBlock.content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
        const failed = resultBlock.isError === true || event.data.error !== undefined
        toolBlock.content = text
        toolBlock.status = failed ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
        break
      }
      default:
        break
    }
  }
  closeReply()

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
