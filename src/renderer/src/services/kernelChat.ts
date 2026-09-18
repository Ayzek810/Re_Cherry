import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { loggerService } from '@logger'
import { isVisionModel } from '@renderer/config/models'
import { providerReasoningCompat, type ReasoningCompatProviderInput } from '@renderer/config/reasoningCompat'
import i18n from '@renderer/i18n'
import { fetchTopicEventsWithRetry, subscribeKernelSessionEvents } from '@renderer/services/kernelEventStream'
import {
  encodeImageFileForKernel,
  type KernelImageInput,
  syncKernelImageAttachment
} from '@renderer/services/kernelImages'
import { autoNameKernelTopic } from '@renderer/services/topicNaming'
import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { toolPermissionsActions } from '@renderer/store/toolPermissions'
import { type UserQuestionEntry, userQuestionsActions } from '@renderer/store/userQuestions'
import type { Assistant, FileMetadata, Model } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'
import {
  AssistantMessageStatus,
  type ErrorMessageBlock,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType,
  type ToolMessageBlock
} from '@renderer/types/newMessage'
import { renameAbortController } from '@renderer/utils/abortController'
import {
  createErrorBlock,
  createImageBlock,
  createMainTextBlock,
  createThinkingBlock,
  createToolBlock
} from '@renderer/utils/messageUtils/create'
import { kernelReasoningEffortsForModel, kernelReasoningLevelFor } from '@renderer/utils/reasoningKernel'
import {
  invalidateKernelRootTopics,
  isRestoredTopicRow,
  kernelKnowsTopic,
  rootTopicIdOf
} from '@renderer/utils/topicBranch'
import type { WorkModeApprovalTier } from '@shared/config/workMode'

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
export async function destroyTurnsInKernel(topicId: string, anchorUserSeqs: number[]): Promise<DestroyTurnsResponse> {
  return (await window.api.dshTopicDestroyTurns(topicId, anchorUserSeqs)) as DestroyTurnsResponse
}

let bridgeInitialized = false

/** 应用启动时调用一次：订阅内核事件流与审批/问答请求帧。 */
export function initKernelBridge(): void {
  if (bridgeInitialized) return
  bridgeInitialized = true
  subscribeKernelSessionEvents((payload) => {
    try {
      handleSessionEvent(payload)
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
          // 三层思考协议修正：登记网关事实 + 泛用家族推断 + 用户 apiOptions 声明（见 config/reasoningCompat.ts）
          const compat = providerReasoningCompat(provider as ReasoningCompatProviderInput, model as Model)
          // v0.3.1 识图通道：视觉模型声明输入模态（pi-ai models[].input）——目录外自定义
          // 视觉模型缺了这条，图片会被内核按纯文本路由降级成 handle 文本，永远不上 wire。
          const input = isVisionModel(model as Model) ? (['text', 'image'] as const) : undefined
          if (reasoningEfforts === undefined && compat === undefined && input === undefined) return model
          return {
            ...model,
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
            ...(compat === undefined ? {} : { compat }),
            ...(input === undefined ? {} : { input: [...input] })
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

/**
 * 转述模型配置同步（v0.3.1 识图通道补全）。变更即推；启动窗内内核未就绪时
 * 只记日志（下一处 provider 变更或重启会重推；describe_images 挂载由发送链
 * 的 builtinTools 决定，路由缺失仅使工具调用明错，不会静默劣化）。
 * prompt 为 '' = 内置默认提示词。
 */
export async function syncImageDescriberToKernel(
  model: { provider: string; id: string } | undefined,
  prompt: string
): Promise<void> {
  try {
    await window.api.dshSyncImageDescriber(
      model === undefined ? null : { provider: model.provider, model: model.id, prompt }
    )
  } catch (error) {
    logger.error(
      'kernelChat: failed to sync image describer config to kernel',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/** 助手当前生效的思考档位（映射为内核档位；非推理模型/auto/default 返回 undefined）。 */
export function assistantReasoningLevel(assistant: Assistant): string | undefined {
  return kernelReasoningLevelFor(assistant.model, assistant.settings?.reasoning_effort)
}

/**
 * 确保内核侧存在该话题的 agent/session（幂等）。工作模式不进建册输入——它是渲染层话题开关，随发送参数生效。
 *
 * v0.3.0-2 目标 B（`report.md` §3.3.2-5）：`dshTopicCreate` 是 **upsert**，对"内核已遗忘的 id"调用
 * 会让该 id **复活**（违反内核兼容契约第 4 节的墓碑纪律）。因此只服务**真正新建**的话题：
 * 来自上次会话的行（`isRestoredTopicRow`）必须先由内核确认存在，否则拒绝建册。
 * 本进程内新建的话题不需要这次确认——内核不认识它是因为它还没首发过（这正是本函数要做的建册）。
 */
export async function ensureKernelTopic(topicId: string, assistant: Assistant): Promise<void> {
  const model = assistant.model
  if (model === undefined || model.provider === undefined) {
    throw new Error(`kernelChat: assistant "${assistant.id}" has no model/provider`)
  }
  if (isRestoredTopicRow(topicId)) {
    const known = await kernelKnowsTopic(topicId)
    // known === null（查询失败）不拒绝：建册本身就要走同一个内核，此时拒绝只会把主操作也挡掉
    if (known === false) {
      throw new Error(`kernelChat: topic "${topicId}" is unknown to the kernel registry; refusing to recreate it`)
    }
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
  // 建册成功 → 成员集合变了（新建的行现在在内核里）
  invalidateKernelRootTopics()
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
    tier?: WorkModeApprovalTier
    /** 随消息附带的图片（已规范化进预算，v0.3.1 识图通道）。 */
    images?: KernelImageInput[]
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
 * 提取用户消息携带的图片并规范化为内核附件载荷新形态（v0.3.1 识图通道）。
 * 图片块 → FileMetadata → canvas 解码/EXIF 摆正/压预算 → base64 wire 载荷。
 * 单个图片失败即抛错（发送链可见失败），由附件仓库做最后防线校验。
 */
export async function extractImagesFromUserMessage(message: Message): Promise<KernelImageInput[]> {
  const entities = store.getState().messageBlocks.entities
  const files: FileMetadata[] = []
  for (const blockId of message.blocks ?? []) {
    const block = entities[blockId]
    if (block !== undefined && block.type === MessageBlockType.IMAGE && block.file !== undefined) {
      files.push(block.file)
    }
  }
  if (files.length === 0) return []
  return Promise.all(files.map((file) => encodeImageFileForKernel(file)))
}

/**
 * 从内核会话日志还原一个话题的 Message/MessageBlock（打开话题的初始渲染用）。
 * 按"轮"归并（B8：一轮 = 一条回答）：turn 内所有 assistant/message（多 step）的说话块
 * 顺序追加进同一条回答消息；tool/call + tool/result 按 callId 配对产出统一工具块；
 * 用户消息的 image 内容块经 Dsh_AttachmentSync 幂等同步回本地文件仓后产出 IMAGE 块（v0.3.1）。
 * @returns 投影结果（空历史 = 空数组，是真实状态）；`null` = 内核在重试窗口内始终不可达
 *   （真失败——调用方不得把它当"没有消息"渲染，须允许后续重进重拉）。
 *   启动窗口的瞬时失败（handler 未注册 / agent 异步 resume）由 fetchTopicEventsWithRetry
 *   覆盖（v0.3.0-5：此前一次瞬时失败即返回 null → 话题空白且被"已加载"短路卡住）。
 */
export async function loadKernelTopicMessages(
  topicId: string
): Promise<{ messages: Message[]; blocks: MessageBlock[] } | null> {
  // UI 视界取数：注入的插件源消息已在内核侧剔除（渲染层不再需要可见性判据）
  const events = await fetchTopicEventsWithRetry(topicId)
  if (events === null) {
    logger.warn(`kernelChat: kernel unreachable for topic "${topicId}" after retry window`)
    return null
  }
  return await projectEventsToMessages(topicId, events)
}

// ---------------------------------------------------------------------------
// 事件投影
// ---------------------------------------------------------------------------

function handleSessionEvent(payload: { topicId: string; event: SessionEvent }): void {
  const { topicId, event } = payload
  switch (event.type) {
    case 'user/message': {
      // 注入的插件源消息（RuntimeContextProjection 的工具面快照、档位标注等）已由内核在
      // 广播口剔除（kernel/sessionEventView.ts），这里收到的一定是真实发送——回执 FIFO
      // 不再有被注入事件抢占名额、把本地消息的回执 seq 记到注入事件上的风险（v0.3.0-1
      // 结构化：可见性由单一判据保证，本层无需再判）。
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
      // 回合成功 → 话题自动命名（V1 原理：轻量调用 + 设置面可控，见 services/topicNaming.ts）。
      // 错误/中断回合不命名：失败回合的名字没有语义，留给下一次成功的轮次。
      if (event.data.reason.kind !== 'error' && event.data.reason.kind !== 'aborted') {
        void autoNameKernelTopic(topicId)
      }
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
function finalizeStep(topicId: string, event: Extract<SessionEvent, { type: 'assistant/message' }>): void {
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
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
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

/** v0.3.1-1：turn/end kind=error → ErrorMessageBlock 载荷。
 * UNKNOWN_MODEL（话题绑定的模型不在内核路由集——渲染层模型选择与路由集脱同步）换双语
 * 友好文案；其余错误保留引擎原文，由 ErrorBlock 的分类体系渲染。 */
function serializedTurnError(reason: { error?: { message: string; code: string } }): SerializedError {
  const raw = reason.error
  const code = raw?.code ?? 'TURN_FAILED'
  let message: string = raw?.message ?? 'turn ended with error'
  if (code === 'UNKNOWN_MODEL') {
    const model = /has no configured model "([^"]+)"/.exec(message)?.[1]
    if (model !== undefined) {
      message = i18n.t('kernelChat.unknownModelError', { model })
    }
  }
  return { name: 'KernelTurnError', message, stack: null, code }
}

/** v0.3.1-1：空响应块载荷（回合正常收尾但零可见输出）。 */
function serializedEmptyTurn(): SerializedError {
  return {
    name: 'KernelTurnError',
    message: i18n.t('kernelChat.emptyResponse'),
    stack: null,
    code: 'EMPTY_RESPONSE'
  }
}

/** v0.3.1-1：本轮是否产出过可见内容（非空正文/思考；工具卡本身即可见——
 * 纯工具轮是合法形态，不得按空响应误报）。 */
function turnHasVisibleOutput(
  state: TurnState,
  entities: Record<string, MessageBlock | undefined>
): boolean {
  return state.blockIds.some((blockId) => {
    const block = entities[blockId]
    if (block === undefined) return false
    switch (block.type) {
      case MessageBlockType.MAIN_TEXT:
      case MessageBlockType.THINKING:
        return typeof block.content === 'string' && block.content.trim().length > 0
      case MessageBlockType.TOOL:
        return true
      default:
        return false
    }
  })
}

function finishTurn(topicId: string, reason: { kind: string; error?: { message: string; code: string } }): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const failed = reason.kind === 'error'
  const aborted = reason.kind === 'aborted'
  if (failed) {
    logger.error(`kernelChat: turn failed for topic "${topicId}": ${reason.error?.message ?? 'unknown'}`)
  }
  // v0.3.1-1：失败/空响应以 ERROR 块投影进消息本体（直播路径）。此前只落日志并把
  // 消息状态置 error，气泡里没有任何可见内容（"空回复"案的呈现层缺陷）。历史还原路径
  // （projectEventsToMessages 的 turn/end case）与此同构。
  const turnErrorBlock: ErrorMessageBlock | undefined = failed
    ? createErrorBlock(state.assistantMessageId, serializedTurnError(reason))
    : !aborted && !turnHasVisibleOutput(state, store.getState().messageBlocks.entities)
      ? createErrorBlock(state.assistantMessageId, serializedEmptyTurn())
      : undefined
  if (turnErrorBlock !== undefined) {
    state.blockIds.push(turnErrorBlock.id)
    store.dispatch(upsertManyBlocks([turnErrorBlock]))
    syncMessageBlocks(topicId, state)
  }
  // 只收尾仍处于流式/进行中的块（已终态的块保持其成功/失败原样）
  const settleStatus = failed
    ? MessageBlockStatus.ERROR
    : aborted
      ? MessageBlockStatus.PAUSED
      : MessageBlockStatus.SUCCESS
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
  // v0.3.1 第三轮：fulfilled 的**真来源**。旧位置在发送任务队列排空时设 true——queue 排
  // 空≠回合结束（内核流还在打），绿点提前亮然后被"看没了"，也从不按回合亮。规则：回合
  // **成功**结束且用户没盯着它（盯着 = 看完了，不算未读）；错误/中断回合不置。
  if (!failed && !aborted) {
    // 写入端直接写**根 id 投影**（v0.3.1 第三轮补丁）：重发/旁答的回合发生在 fork 出的
    // 子会话上，侧栏只渲染根行——不折叠的话子会话的"完成"永远照不到根行（重发流绿点
    // 全灭）。判定"用户正盯着"也按家族：currentTopicId 与本回合同根 = 同一串对话在眼前。
    const rows = store.getState().assistants.assistants.flatMap((assistant) => assistant.topics ?? [])
    const rootId = rootTopicIdOf(topicId, rows)
    const current = store.getState().messages.currentTopicId
    const watchingFamily = current !== null && rootTopicIdOf(current, rows) === rootId
    if (!watchingFamily) {
      store.dispatch(newMessagesActions.setTopicFulfilled({ topicId: rootId, fulfilled: true }))
    }
  }
  // 兜底清理：回合结束（含错误/中断）时该话题不应再有未决审批/问答
  store.dispatch(toolPermissionsActions.clearByTopic({ topicId }))
  store.dispatch(userQuestionsActions.clearByTopic({ topicId }))
  streams.delete(topicId)
  pendingStubs.delete(topicId)
}

// ---------------------------------------------------------------------------
// 历史还原：session 事件 → Cherry Message/MessageBlock
// ---------------------------------------------------------------------------

async function projectEventsToMessages(
  topicId: string,
  events: SessionEvent[]
): Promise<{ messages: Message[]; blocks: MessageBlock[] }> {
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
    /** v0.3.1-1：本轮是否产出过可见内容（正文/思考/工具卡）——turn/end 空轮守门。 */
    sawVisibleOutput: boolean
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
        // 注入消息已在内核侧从 UI 视界剔除（kernel/sessionEventView.ts）：此处不再有
        // "插件源消息"分支——到达这里的 user/message 一定是真实用户轮，直接开新气泡。
        closeReply()
        const messageId = kernelMessageId(topicId, event.seq)
        lastUserMessageId = messageId
        const blockIds: string[] = []
        for (const content of event.data.content) {
          if (content.type === 'text' && content.text.length > 0) {
            const block = createMainTextBlock(messageId, content.text, { status: MessageBlockStatus.SUCCESS })
            blocks.push(block)
            blockIds.push(block.id)
          } else if (content.type === 'image') {
            // v0.3.1：内核只存图片 ref——按 ref 同步字节回本地文件仓（幂等）再产出 IMAGE 块。
            // 同步失败不吞：投影占位文本，重启后重进话题可再同步。
            const file = await syncKernelImageAttachment(content.attachment)
            if (file !== null) {
              const block = createImageBlock(messageId, { file, status: MessageBlockStatus.SUCCESS })
              blocks.push(block)
              blockIds.push(block.id)
            } else {
              const failed = createMainTextBlock(messageId, i18n.t('kernelChat.imageLoadFailed'), {
                status: MessageBlockStatus.SUCCESS
              })
              blocks.push(failed)
              blockIds.push(failed.id)
            }
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
            toolBlocks: new Map(),
            sawVisibleOutput: false
          }
        }
        // 说话块顺序追加；tool-call 块由 tool/call + tool/result 事件负责（避免双卡）
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text !== undefined && block.text.length > 0) {
            const main = createMainTextBlock(reply.messageId, block.text, { status: MessageBlockStatus.SUCCESS })
            blocks.push(main)
            reply.blockIds.push(main.id)
            reply.sawVisibleOutput = true
          } else if (block.type === 'reasoning' && block.text !== undefined && block.text.length > 0) {
            const thinking = createThinkingBlock(reply.messageId, block.text, { status: MessageBlockStatus.SUCCESS })
            blocks.push(thinking)
            reply.blockIds.push(thinking.id)
            reply.sawVisibleOutput = true
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
        // 工具卡本身即可见输出（纯工具轮合法，空轮守门不误报）
        reply.sawVisibleOutput = true
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
          logger.warn(
            `kernelChat: tool result without a tracked call (${resultBlock.toolCallId}) in topic "${topicId}"`
          )
          break
        }
        const text = (resultBlock.content ?? [])
          .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
          .join('\n')
        const failed = resultBlock.isError === true || event.data.error !== undefined
        toolBlock.content = text
        toolBlock.status = failed ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
        break
      }
      case 'turn/end': {
        // v0.3.1-1：错误/空轮的历史投影与直播路径（finishTurn）同构。此前投影循环
        // 没有 turn/end case，失败轮重新打开话题后只剩空气泡。轮内没有任何
        // assistant/message 时（如 UNKNOWN_MODEL 在引擎之前失败），先补一条承载
        // 消息（id 用本事件 seq），否则错误块无处可挂。
        const reason = event.data.reason as { kind: string; error?: { message: string; code: string } }
        const wantsErrorBlock = reason.kind === 'error'
        // 空轮守门：正常收尾但零可见输出；aborted 不投（PAUSED 语义）。
        const wantsEmptyBlock =
          reason.kind !== 'error' && reason.kind !== 'aborted' && !(reply?.sawVisibleOutput ?? false)
        if (!wantsErrorBlock && !wantsEmptyBlock) break
        if (reply === null) {
          if (lastUserMessageId === undefined) break
          const messageId = kernelMessageId(topicId, event.seq)
          const message = createKernelMessage(messageId, topicId, assistantId, 'assistant', [], {
            askId: lastUserMessageId,
            status: 'error' as AssistantMessageStatus
          })
          messages.push(message)
          reply = {
            messageId,
            message,
            blockIds: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            toolBlocks: new Map(),
            sawVisibleOutput: false
          }
        }
        const turnBlock = wantsErrorBlock
          ? createErrorBlock(reply.messageId, serializedTurnError(reason))
          : createErrorBlock(reply.messageId, serializedEmptyTurn())
        // 消息级 status 与直播路径（finishTurn）对齐：error 轮置 error；
        // 空轮保持 success（直播路径成功收尾语义，错误承载在块内）
        if (wantsErrorBlock) {
          reply.message.status = 'error' as AssistantMessageStatus
        }
        blocks.push(turnBlock)
        reply.blockIds.push(turnBlock.id)
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
      texts.push(block.content)
    }
  }
  return texts.join('\n')
}
