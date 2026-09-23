/**
 * v0.3.1-1 空回复案投影守门测试（历史还原路径 projectEventsToMessages）。
 *
 * 锁定语义：
 *   1. turn/end kind=error → ERROR 块投影进该轮回答消息（直播 finishTurn 与此同构）；
 *      轮内没有 assistant/message（如 UNKNOWN_MODEL 在引擎之前失败）时补承载消息。
 *   2. UNKNOWN_MODEL → 错误码透传，message 换双语文案（键回退亦算命中）。
 *   3. completed 且零可见输出 → EMPTY_RESPONSE 独立错误块。
 *   4. completed 且轮内有 text/reasoning/tool → 不投（合法形态不得误报；纯工具轮合法）。
 *   5. aborted → 不投（PAUSED 语义，直播路径置 PAUSED）。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { fetchTopicEventsWithRetry } from '@renderer/services/kernelEventStream'
import type { ErrorMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import { loadKernelTopicMessages } from '../kernelChat'

vi.mock('@renderer/services/kernelEventStream', () => ({
  fetchTopicEventsWithRetry: vi.fn(async () => null),
  subscribeKernelSessionEvents: vi.fn(() => () => {})
}))

const SID = 'sess-1'
const TOPIC = 'topic-turn-projection'

type Reason = { kind: string; error?: { message: string; code?: string } }

const ev = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ session_id: SID, seq, time: 1000 + seq, type, data }) as unknown as SessionEvent

const userMsg = (seq: number, text: string): SessionEvent =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }] })

const asstMsg = (seq: number, content: unknown[]): SessionEvent =>
  ev(seq, 'assistant/message', {
    message: { role: 'assistant', content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
    usage: { inputTokens: 1, outputTokens: 2 }
  })

const turnEnd = (seq: number, reason: Reason): SessionEvent => ev(seq, 'turn/end', { reason })

async function project(
  events: SessionEvent[]
): Promise<NonNullable<Awaited<ReturnType<typeof loadKernelTopicMessages>>>> {
  vi.mocked(fetchTopicEventsWithRetry).mockResolvedValue(events as never)
  const result = await loadKernelTopicMessages(TOPIC)
  if (result === null) throw new Error('project 结果为 null')
  return result
}

function errorBlocksOf(blocks: unknown[]): ErrorMessageBlock[] {
  return blocks.filter((b) => (b as { type?: string }).type === MessageBlockType.ERROR) as ErrorMessageBlock[]
}

describe('kernelChat turn 投影（v0.3.1-1 空回复案）', () => {
  it('UNKNOWN_MODEL 失败轮（无 assistant/message）补承载消息并投影 ERROR 块', async () => {
    const { messages, blocks } = await project([
      userMsg(2, '你好'),
      turnEnd(3, {
        kind: 'error',
        error: {
          code: 'UNKNOWN_MODEL',
          message: 'pi-ai provider "silicon" has no configured model "deepseek-ai/DeepSeek-V4-Flash"'
        }
      })
    ])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const answer = messages[1]
    expect(answer.status).toBe('error')
    expect(answer.blocks.length).toBe(1)
    const [errBlock] = errorBlocksOf(blocks)
    expect(errBlock).toBeDefined()
    expect(errBlock.error?.code).toBe('UNKNOWN_MODEL')
    // message 换成了双语文案（i18n 未初始化时按键回退——非空字符串即命中投影层换写）
    expect(typeof errBlock.error?.message).toBe('string')
    expect((errBlock.error?.message ?? '').length).toBeGreaterThan(0)
    expect(errBlock.error?.message ?? '').not.toContain('pi-ai provider')
  })

  it('失败轮已有 assistant 内容：ERROR 块挂进既有回答消息末尾', async () => {
    const { messages, blocks } = await project([
      userMsg(2, 'hi'),
      asstMsg(4, [{ type: 'text', text: '部分回复' }]),
      turnEnd(5, { kind: 'error', error: { message: 'boom' } })
    ])
    const answer = messages[1]
    expect(answer.status).toBe('error')
    expect(answer.blocks.length).toBe(2)
    const lastBlock = blocks.find((b) => b.id === answer.blocks[1])
    expect(lastBlock?.type).toBe(MessageBlockType.ERROR)
    // 无 code 的 error → 投影层兜底 TURN_FAILED，message 保留引擎原文
    const [errBlock] = errorBlocksOf(blocks)
    expect(errBlock.error?.code).toBe('TURN_FAILED')
    expect(errBlock.error?.message).toBe('boom')
  })

  it('completed 零可见输出：投 EMPTY_RESPONSE 独立错误块', async () => {
    const { messages, blocks } = await project([userMsg(2, 'hi'), turnEnd(5, { kind: 'completed' })])
    const answer = messages[1]
    expect(answer.status).toBe('error')
    const [errBlock] = errorBlocksOf(blocks)
    expect(errBlock.error?.code).toBe('EMPTY_RESPONSE')
    expect(typeof errBlock.error?.message === 'string' && (errBlock.error?.message ?? '').length > 0).toBe(true)
  })

  it('completed 且有正文：正常投影，无 ERROR/EMPTY 块', async () => {
    const { messages, blocks } = await project([
      userMsg(2, 'hi'),
      asstMsg(4, [{ type: 'text', text: '答案内容' }]),
      turnEnd(5, { kind: 'completed' })
    ])
    const answer = messages[1]
    expect(answer.status).toBe('success')
    expect(errorBlocksOf(blocks)).toHaveLength(0)
  })

  it('completed 纯工具轮（含 ask_user tool-call）：合法形态，不投空响应', async () => {
    const { messages, blocks } = await project([
      userMsg(2, '1'),
      asstMsg(4, [
        { type: 'reasoning', text: '思考' },
        { type: 'tool-call', id: 'c1', name: 'ask_user_question', arguments: '{}' }
      ]),
      ev(6, 'tool/call', { callId: 'c1', name: 'ask_user_question', arguments: '{}' }),
      ev(7, 'tool/result', {
        message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }] }
      }),
      turnEnd(8, { kind: 'completed' })
    ])
    const answer = messages[1]
    expect(answer.status).toBe('success')
    expect(errorBlocksOf(blocks)).toHaveLength(0)
  })

  it('aborted：不建承载消息也不投空响应（PAUSED 语义）', async () => {
    const { messages, blocks } = await project([userMsg(2, 'hi'), turnEnd(5, { kind: 'aborted' })])
    expect(messages.map((m) => m.role)).toEqual(['user'])
    expect(errorBlocksOf(blocks)).toHaveLength(0)
  })
})

describe('generate_image 工具结果投影（v0.3.3 批次5）', () => {
  const toolCall = (seq: number): SessionEvent =>
    ev(seq, 'tool/call', { callId: 'c1', name: 'generate_image', arguments: '{"prompt":"a cat"}' })

  // 真实事件流里 tool/call 之前必有 assistant/message（模型输出承载）；tool-call 内容块本身
  // 不生成工具卡（投影层注释：卡由 tool/call + tool/result 负责），它的作用是让本轮"有回复可言"。
  const asstCarrier = (seq: number): SessionEvent =>
    asstMsg(seq, [{ type: 'tool-call', id: 'c1', name: 'generate_image', arguments: '{"prompt":"a cat"}' }])

  const toolResult = (seq: number, meta: unknown, isError = false): SessionEvent =>
    ev(seq, 'tool/result', {
      message: {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Generated 1 image(s)' }], isError }
        ]
      },
      ...(meta !== undefined ? { meta } : {})
    })

  it('成功结果（presentationMeta 含 images）→ 追加 IMAGE 块，generateImageResponse 元数据可渲染', async () => {
    const { messages, blocks } = await project([
      userMsg(2, '画一只猫'),
      asstCarrier(3),
      toolCall(4),
      toolResult(5, { kind: 'generate-image', images: ['data:image/png;base64,aGk='] }),
      turnEnd(6, { kind: 'completed' })
    ])
    const answer = messages[1]
    expect(answer.status).toBe('success')
    const imageBlocks = blocks.filter((b) => (b as { type?: string }).type === MessageBlockType.IMAGE)
    expect(imageBlocks).toHaveLength(1)
    const metadata = (imageBlocks[0] as { metadata?: { generateImageResponse?: { images?: string[] } } }).metadata
    expect(metadata?.generateImageResponse?.images).toEqual(['data:image/png;base64,aGk='])
  })

  it('meta kind 不匹配或缺 images：不投影 IMAGE 块（不误报）', async () => {
    const { blocks } = await project([
      userMsg(2, '画一只猫'),
      asstCarrier(3),
      toolCall(4),
      toolResult(5, { kind: 'web-search', results: [] }),
      turnEnd(6, { kind: 'completed' })
    ])
    expect(blocks.filter((b) => (b as { type?: string }).type === MessageBlockType.IMAGE)).toHaveLength(0)
  })

  it('失败结果（isError）：不投影 IMAGE 块', async () => {
    const { blocks } = await project([
      userMsg(2, '画一只猫'),
      asstCarrier(3),
      toolCall(4),
      toolResult(5, { kind: 'generate-image', images: ['data:image/png;base64,aGk='] }, true),
      turnEnd(6, { kind: 'completed' })
    ])
    expect(blocks.filter((b) => (b as { type?: string }).type === MessageBlockType.IMAGE)).toHaveLength(0)
  })
})
