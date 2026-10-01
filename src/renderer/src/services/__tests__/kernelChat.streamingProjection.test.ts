/**
 * 直播投影机测：思考/正文分块与 thinking_millsec 冻结语义。
 *
 * 真实事件序列（turn/start → assistant/chunk ×N → assistant/message → turn/end）驱动
 * handleSessionEvent（经 initKernelBridge 的订阅回调），逐 delta 断言：
 *   1. 思考块流式期 STREAMING；首条正文 delta 冻结（SUCCESS + thinking_millsec 落块）——
 *      冻结值 = 推理跨度，正文流式时间不计入
 *   2. 冻结后正文块逐 delta 增长（"流几字停顿"症状的回归门）
 *   3. assistant/message 最终替换块携带同一冻结值；正文块全文就位
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { cancelActiveTurn, initKernelBridge, kernelAnchorOf, sendToKernel } from '@renderer/services/kernelChat'
import type { KernelSessionEventPayload } from '@renderer/services/kernelEventStream'
import { hasLiveTurn, isTurnCancelled } from '@renderer/services/topicTurnRuntime'
import store from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Message, MessageBlock, ThinkingMessageBlock } from '@renderer/types/newMessage'
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

/**
 * 取一条消息**实际渲染**的块。
 *
 * 消息自身的 `blocks` 列表才是渲染源。不能只按 `messageId` 全表扫描：同一个话题里再次发送
 * （或跨用例复用 messageId）时，上一轮遗留的同 messageId 块仍在 store 里，扫描会先命中那条
 * 陈旧的空块——断言就会读到"界面根本不显示的块"。列表为空时才退回扫描（个别用例未建消息实体）。
 */
const blocksOf = (messageId: string): MessageBlock[] => {
  const entities = store.getState().messageBlocks.entities
  const listed = store.getState().messages.entities[messageId]?.blocks
  if (listed !== undefined && listed.length > 0) {
    return listed.map((blockId) => entities[blockId]).filter((block): block is MessageBlock => block !== undefined)
  }
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

describe('kernelChat 直播投影（思考计时冻结 + 正文流式回归门）', () => {
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
    expect(thinking?.status).toBe(MessageBlockStatus.PAUSED)
    expect(thinking?.thinking_millsec ?? 0).toBeGreaterThan(0)
  })

  it('取证钩子（v1）：思考期不算停顿；任意事件断流超阈值才告警', async () => {
    initKernelBridge()
    const topic = TOPIC + '-stall'
    const send = sendToKernel(topic, 'hi', STUB_ID + '-stall', 'stub-user')
    await Promise.resolve()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let clock = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const stallWarns = (): string[] =>
      warnSpy.mock.calls
        .flat()
        .filter((arg): arg is string => typeof arg === 'string' && arg.includes('no stream activity'))

    try {
      emit(topic, 2, 'turn/start', { turn: 1 })
      // 长思考：3.9s 内只有 reasoning delta、没有正文（旧钩子会误报为"正文流式停顿"）
      clock = 100
      chunk(topic, 3, 'reasoning-delta', '长思考')
      clock = 4000
      chunk(topic, 4, 'text-delta', '正文')
      await flushFrames()
      expect(stallWarns()).toHaveLength(0)

      // 真断流：9s 内内核一个事件都没有 → 恢复时告警
      clock = 13000
      chunk(topic, 5, 'text-delta', '恢复')
      await flushFrames()
      expect(stallWarns().length).toBeGreaterThan(0)

      emit(topic, 6, 'turn/end', { reason: { kind: 'completed' } })
      await send
    } finally {
      nowSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

/**
 * 回合收尾必须把「未回执的本地 user 消息 FIFO」清掉。旧实现只在回执到达时 shift，
 * 回执没到（内核侧失败/中断/删除轮次）的那一条会永久留在队列里，并让下一回合的回执
 * 把 seq 配对到**错误的**本地消息 id 上（锚点错位）。
 */
describe('kernelChat 回合收尾的 FIFO 清理', () => {
  const TOPIC = 'topic-fifo-cleanup'
  const putUserMessage = (id: string, blockId: string): void => {
    store.dispatch(
      newMessagesActions.messagesReceived({
        topicId: TOPIC,
        messages: [
          {
            id,
            role: 'user',
            topicId: TOPIC,
            assistantId: 'assistant-1',
            createdAt: new Date().toISOString(),
            status: 'success',
            blocks: [blockId]
          } as unknown as Message
        ]
      })
    )
  }

  it('上一回合的回执没到 → 下一回合回执不得错配到旧消息（旧 id 的 seq 残留被清）', async () => {
    initKernelBridge()
    // 第一回合：本地登记 user-a，但内核**没有**回执（只有 turn/start + turn/end）
    const first = sendToKernel(TOPIC, 'first', 'stub-fifo-1', 'user-a')
    await Promise.resolve()
    emit(TOPIC, 2, 'turn/start', { turn: 1 })
    emit(TOPIC, 3, 'turn/end', { reason: { kind: 'aborted' } })
    await first

    // 第二回合：登记 user-b，回执 seq=4
    const second = sendToKernel(TOPIC, 'second', 'stub-fifo-2', 'user-b')
    await Promise.resolve()
    putUserMessage('user-a', 'block-a')
    putUserMessage('user-b', 'block-b')
    emit(TOPIC, 4, 'user/message', { content: [{ type: 'text', text: 'second' }] })
    await second

    const state = store.getState().messages
    // 回执只能认领 user-b：user-a 的残留登记不得抢占 FIFO 队首
    expect(state.entities['user-a']).toBeDefined()
    expect(state.entities['user-b']).toBeUndefined()
    const remapped = state.entities[`kernel-${TOPIC}-4`]
    expect(remapped).toBeDefined()
    expect(remapped?.blocks).toEqual(['block-b'])
    // 改写后的 id 即锚点：的"锚点从 id 解析"在改写后成立
    expect(kernelAnchorOf(TOPIC, remapped)).toEqual({ sessionId: TOPIC, seq: 4 })
  })

  it('回执前的本地 uuid 没有内核锚点（"回执前 fork"显式不支持）', () => {
    expect(kernelAnchorOf(TOPIC, { id: 'kernel-x-7' } as Message)).toEqual({ sessionId: 'x', seq: 7 })
    expect(kernelAnchorOf(TOPIC, { id: 'local-uuid-no-receipt' } as Message)).toBeUndefined()
    expect(kernelAnchorOf(TOPIC, { id: 'kernel-x-notaseq' } as Message)).toBeUndefined()
  })
})

/**
 * 暂停的单一路径（2026-10-01 重做）：按**话题**记账，键就是 topicId，没有键迁移、没有兜底、
 * 没有残留。本组钉住三件事：
 *   1. 回合开始即建立记录；`turn/end` 后记录清除（不存在"每回合泄一个闭包"）；
 *   2. 暂停当帧把消息落 PAUSED（不等内核 `turn/end`）；
 *   3. 暂停之后到达的正文增量被**丢弃**——界面立刻停住，与内核边界收尾解耦。
 */
describe('kernelChat 暂停：按话题记账 + 当帧落态 + 丢弃后续增量', () => {
  const TOPIC = 'topic-pause-single-path'
  const STUB = 'stub-pause-single-path'
  const USER_UUID = 'user-uuid-pause-single-path'
  // 每条用例一套 id：真实发送每回合都新建 assistant 消息（新 stub id），
  // 复用同一 id 会把上一轮留下的块混进本次读取（测试脚手架伪影，不是投影行为）。
  const STUB_2 = 'stub-pause-single-path-2'
  const USER_UUID_2 = 'user-uuid-pause-single-path-2'

  /**
   * 真实发送顺序是"先建助手消息（messagesReceived），再 sendToKernel"。
   * 必须先建消息实体：`updateMessage` 对不存在的 id 是空操作，
   * 缺了它 `startTurn`/`cancelActiveTurn` 落的 status 与 blocks 无处可落（脚手架伪影）。
   */
  const putAssistantStub = (id: string): void => {
    store.dispatch(
      newMessagesActions.messagesReceived({
        topicId: TOPIC,
        messages: [
          {
            id,
            role: 'assistant',
            topicId: TOPIC,
            assistantId: 'assistant-1',
            createdAt: new Date().toISOString(),
            status: 'processing',
            blocks: []
          } as unknown as Message
        ]
      })
    )
  }

  it('回合开始建立记录、turn/end 清除记录', async () => {
    initKernelBridge()
    putAssistantStub(STUB)
    const send = sendToKernel(TOPIC, 'hi', STUB, USER_UUID)
    await Promise.resolve()

    emit(TOPIC, 3, 'turn/start', { turn: 1 })
    await flushFrames()
    expect(hasLiveTurn(TOPIC)).toBe(true)

    emit(TOPIC, 4, 'turn/end', { reason: { kind: 'completed' } })
    await send
    await flushFrames()
    expect(hasLiveTurn(TOPIC)).toBe(false)
  })

  it('暂停当帧落 PAUSED，且之后的正文增量被丢弃', async () => {
    initKernelBridge()
    putAssistantStub(STUB_2)
    const send = sendToKernel(TOPIC, 'hi', STUB_2, USER_UUID_2)
    await Promise.resolve()

    emit(TOPIC, 3, 'turn/start', { turn: 1 })
    chunk(TOPIC, 4, 'text-delta', '第一段')
    await flushFrames()
    const beforePause = mainContentOf(STUB_2) ?? ''
    expect(beforePause).toContain('第一段')

    // 暂停：当帧落态（不依赖内核 turn/end）
    expect(cancelActiveTurn(TOPIC)).toBe(true)
    expect(isTurnCancelled(TOPIC)).toBe(true)
    expect(store.getState().messages.entities[STUB_2]?.status).toBe('paused')

    // 暂停之后到达的增量必须被丢弃：界面立刻停住
    chunk(TOPIC, 5, 'text-delta', '第二段不该出现')
    await flushFrames()
    const afterDelta = mainContentOf(STUB_2) ?? ''
    expect(afterDelta).toBe(beforePause)
    expect(afterDelta).not.toContain('第二段不该出现')

    // 收尾仍然清记录（幂等：turn/end 再做一次终态对账）
    emit(TOPIC, 6, 'turn/end', { reason: { kind: 'aborted' } })
    await send
    await flushFrames()
    expect(hasLiveTurn(TOPIC)).toBe(false)
  })
})
