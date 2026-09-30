/**
 * v0.4.6-1 直播投影机测：思考/正文分块与 thinking_millsec 冻结语义。
 *
 * 真实事件序列（turn/start → assistant/chunk ×N → assistant/message → turn/end）驱动
 * handleSessionEvent（经 initKernelBridge 的订阅回调），逐 delta 断言：
 *   1. 思考块流式期 STREAMING；首条正文 delta 冻结（SUCCESS + thinking_millsec 落块）——
 *      冻结值 = 推理跨度，正文流式时间不计入
 *   2. 冻结后正文块逐 delta 增长（"流几字停顿"症状的回归门）
 *   3. assistant/message 最终替换块携带同一冻结值；正文块全文就位
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { initKernelBridge, sendToKernel } from '@renderer/services/kernelChat'
import type { KernelSessionEventPayload } from '@renderer/services/kernelEventStream'
import store from '@renderer/store'
import type { MessageBlock, ThinkingMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionListener = (payload: KernelSessionEventPayload) => void

const listeners: SessionListener[] = []

vi.mock('@renderer/services/kernelEventStream', () => ({
  fetchTopicEventsWithRetry: vi.fn(async () => []),
  subscribeKernelSessionEvents: vi.fn((callback: SessionListener) => {
    listeners.push(callback)
    return () => undefined
  })
}))

const TOPIC = 'topic-stream-proj'
const SID = 'sess-stream'
const STUB_ID = 'stub-assistant-stream'

const emit = (topicId: string, seq: number, type: string, data: unknown): void => {
  const event = { session_id: SID, seq, time: 1000 + seq, type, data } as unknown as SessionEvent
  for (const listener of listeners) listener({ topicId, event })
}

/** 等 rAF 队列落地（flushBlockUpdate 经 requestAnimationFrame 合并派发）。 */
const flushFrames = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

const chunk = (topicId: string, seq: number, type: string, text: string, step = 1): void =>
  emit(topicId, seq, 'assistant/chunk', { step, chunk: { type, text } })

const blocksOf = (messageId: string): MessageBlock[] => {
  const entities = store.getState().messageBlocks.entities
  return Object.values(entities).filter(
    (block): block is MessageBlock => block !== undefined && block.messageId === messageId
  )
}

const thinkingBlockOf = (messageId: string): ThinkingMessageBlock | undefined =>
  blocksOf(messageId).find((block) => block.type === MessageBlockType.THINKING)

const mainContentOf = (messageId: string): string | undefined => {
  const main = blocksOf(messageId).find((block) => block.type === MessageBlockType.MAIN_TEXT) as
    | { content?: string }
    | undefined
  return main?.content
}

beforeEach(() => {
  // 注意：initKernelBridge 有 bridgeInitialized 单例守卫，订阅回调跨用例共享——
  // 不得清空 listeners（否则后续用例 emit 无人接收）。
  // window.api 最小面：initKernelBridge 的审批/问答订阅 + sendToKernel 的发送 IPC。
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    dshOnApprovalRequest: vi.fn(),
    dshOnQuestionRequest: vi.fn(),
    dshTopicSend: vi.fn(async () => ({ ok: true })),
    dshTopicCreate: vi.fn(async () => ({ ok: true })),
    dshTopicEvents: vi.fn(async () => ({ events: [] }))
  }
})

describe('kernelChat 直播投影（v0.4.6-1 思考计时冻结 + 正文流式回归门）', () => {
  it('正文逐 delta 增长；推理结束瞬间冻结思考块（SUCCESS + thinking_millsec 落块）', async () => {
    initKernelBridge()
    expect(listeners.length).toBeGreaterThan(0)

    // 登记本轮 stub（sendToKernel 的最小路径：dshTopicSend mock 由 renderer.setup 兜底）。
    const send = sendToKernel(TOPIC, 'hi', STUB_ID, 'stub-user')
    await Promise.resolve()

    emit(TOPIC, 2, 'turn/start', { turn: 1 })
    chunk(TOPIC, 3, 'reasoning-delta', '思考第一行')
    chunk(TOPIC, 4, 'reasoning-delta', '思考第二行')
    await flushFrames()

    // 思考块流式中：STREAMING、无 thinking_millsec（跳动器工作期）
    const thinkingStream = thinkingBlockOf(STUB_ID)
    expect(thinkingStream?.status).toBe(MessageBlockStatus.STREAMING)
    expect(thinkingStream?.thinking_millsec ?? 0).toBe(0)

    // 首条正文 delta：推理结束 → 冻结（SUCCESS + thinking_millsec>0），跳动器停在同值
    chunk(TOPIC, 5, 'text-delta', '你好')
    await flushFrames()
    const thinkingFrozen = thinkingBlockOf(STUB_ID)
    expect(thinkingFrozen?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(thinkingFrozen?.thinking_millsec ?? 0).toBeGreaterThan(0)
    const frozenValue = thinkingFrozen?.thinking_millsec ?? 0

    // 正文逐 delta 增长（回归门：此前"流几字停顿"即在此处断言失败）
    chunk(TOPIC, 6, 'text-delta', '世界')
    chunk(TOPIC, 7, 'text-delta', '再见')
    await flushFrames()
    const streamed = mainContentOf(STUB_ID)
    expect(streamed).toContain('你好')
    expect(streamed).toContain('世界')
    expect(streamed).toContain('再见')

    // assistant/message：最终替换块携带同一冻结值；主块全文就位
    emit(TOPIC, 8, 'assistant/message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '思考第一行思考第二行' },
          { type: 'text', text: '你好世界再见' }
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }
      },
      usage: { inputTokens: 1, outputTokens: 2 }
    })
    await flushFrames()
    const finalId = `kernel-${TOPIC}-8`
    const thinkingFinal = thinkingBlockOf(finalId)
    expect(thinkingFinal?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(thinkingFinal?.thinking_millsec).toBe(frozenValue)
    expect(mainContentOf(finalId)).toBe('你好世界再见')

    emit(TOPIC, 9, 'turn/end', { reason: { kind: 'completed' } })
    await send
  })

  it('纯推理被打断：PAUSED + 冻结时长（不归 0.1）', async () => {
    initKernelBridge()
    const send = sendToKernel(TOPIC + '-abort', 'hi', STUB_ID + '-abort', 'stub-user')
    await Promise.resolve()

    emit(TOPIC + '-abort', 2, 'turn/start', { turn: 1 })
    chunk(TOPIC + '-abort', 3, 'reasoning-delta', '只推理没说话')
    await flushFrames()
    // 真实推理持续数秒：给计时一个非零跨度（同毫秒发出的诚实时长就是 0）。
    await new Promise((resolve) => setTimeout(resolve, 60))
    emit(TOPIC + '-abort', 4, 'turn/end', { reason: { kind: 'aborted' } })
    await flushFrames()
    await send

    const thinking = thinkingBlockOf(STUB_ID + '-abort')
    console.log('DBG abort thinking:', JSON.stringify({ status: thinking?.status, ms: thinking?.thinking_millsec }))
    expect(thinking?.status).toBe(MessageBlockStatus.PAUSED)
    expect(thinking?.thinking_millsec ?? 0).toBeGreaterThan(0)
  })
})
