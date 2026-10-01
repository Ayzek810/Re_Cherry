/**
 * r2-40 行为门：内核**发送路径**抛错时，回合必须以可见终态收尾。
 *
 * 背景：V1 回调编排（`services/messageStreaming/callbacks/*` + `BlockManager`）整树删除后，
 * 它唯一的活口 `callbacks.onError(error)` 的职责（错误块 + 消息状态 ERROR）改为
 * `messageThunk` 的 catch 就地补齐。这条线一断，失败回合就停在 PENDING 且零块——
 * 渲染出来是一条「空回复」，即 CLAUDE.md §9 禁止的「失败伪装成空结果」。
 *
 * 真实依赖：真 store + 真 reducer + 真 topic 队列；只把 kernelChat 换成「建册即抛」的桩
 * （发送路径的第一跳，抛错后内核不会发 turn/end，finishTurn 的终态收尾不会发生）。
 */
import store from '@renderer/store'
import { sendMessage } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Message } from '@renderer/types'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createMainTextBlock, createMessage } from '@renderer/utils/messageUtils/create'
import { waitForTopicQueue } from '@renderer/utils/queue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SEND_ERROR_MESSAGE = 'kernelChat: topic is unknown to the kernel registry; refusing to recreate it'

const kernelChatMock = vi.hoisted(() => ({
  ensureKernelTopic: vi.fn(),
  extractTextFromUserMessage: vi.fn(() => 'hi'),
  extractImagesFromUserMessage: vi.fn(async () => []),
  sendToKernel: vi.fn(async () => undefined),
  assistantReasoningLevel: vi.fn(() => 'medium')
}))

vi.mock('@renderer/services/kernelChat', () => kernelChatMock)

let topicSeq = 0
const nextTopicId = (): string => `topic-send-fail-${++topicSeq}`

const makeAssistant = (): Assistant =>
  ({
    id: 'assistant-send-fail',
    name: 'assistant-send-fail',
    prompt: '',
    topics: [],
    model: { id: 'model-1', provider: 'provider-1', name: 'Model 1' }
  }) as unknown as Assistant

const assistantMessagesOf = (topicId: string): Message[] =>
  Object.values(store.getState().messages.entities).filter(
    (message): message is Message =>
      message !== undefined && message.topicId === topicId && message.role === 'assistant'
  )

describe('messageThunk：发送路径抛错 → 可见终态（r2-40 回归门）', () => {
  beforeEach(() => {
    // 话题队列排空会触发 endTrace → window.api.trace.saveData；缺它会以未处理拒绝
    // 打断 p-queue 的 idle 事件（onIdle 永不 resolve）。这里给全最小 IPC 面。
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      trace: {
        saveData: vi.fn(async () => undefined),
        addEndMessage: vi.fn(async () => undefined),
        tokenUsage: vi.fn()
      },
      dshTopicStop: vi.fn(async () => undefined),
      dshTopicSend: vi.fn(async () => undefined),
      dshTopicCreate: vi.fn(async () => undefined)
    }
    kernelChatMock.ensureKernelTopic.mockReset()
    kernelChatMock.ensureKernelTopic.mockRejectedValue(new Error(SEND_ERROR_MESSAGE))
  })

  it('助手消息挂 ERROR 块 + 状态 ERROR + loading 停（不得停下 PENDING 空壳）', async () => {
    const topicId = nextTopicId()
    const assistant = makeAssistant()
    const userId = `user-${topicId}`
    const textBlock = createMainTextBlock(userId, '这一轮注定发送失败', { status: MessageBlockStatus.SUCCESS })
    const userMessage = createMessage('user', topicId, assistant.id, { id: userId, blocks: [textBlock.id] })

    await store.dispatch(sendMessage(userMessage, [textBlock], assistant, topicId))
    await waitForTopicQueue(topicId)

    const state = store.getState()
    const assistantMessages = assistantMessagesOf(topicId)
    expect(assistantMessages).toHaveLength(1)
    const failed = assistantMessages[0]
    // §9：失败不得看起来像空结果——消息必须是 ERROR，不能是 PENDING / SUCCESS。
    expect(failed.status).toBe(AssistantMessageStatus.ERROR)

    const blocks = failed.blocks
      .map((blockId) => state.messageBlocks.entities[blockId])
      .filter((block) => block !== undefined)
    const errorBlock = blocks.find((block) => block.type === MessageBlockType.ERROR) as
      | { error?: { message?: string | null } }
      | undefined
    expect(errorBlock).toBeDefined()
    expect(errorBlock?.error?.message ?? '').toContain('refusing to recreate it')

    // loading 必须停：失败回合不得把加载动画挂在话题上。
    expect(state.messages.loadingByTopic[topicId]).toBe(false)
  })
})
