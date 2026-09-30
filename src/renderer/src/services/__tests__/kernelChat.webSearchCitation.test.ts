/**
 * v0.4 验收轮：网络搜索引用载体投影守门（用户反馈"网络搜索没有清单卡"）。
 * web-search meta（presentationMeta 通道）→ CITATION 载体块 → formatCitationsFromBlock
 * 应产出 websearch 引用条目（与 knowledge 形态同管线）。历史还原路径投影，直播同构。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { fetchTopicEventsWithRetry } from '@renderer/services/kernelEventStream'
import { formatCitationsFromBlock } from '@renderer/store/messageBlock'
import type { CitationMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import { loadKernelTopicMessages } from '../kernelChat'

vi.mock('@renderer/services/kernelEventStream', () => ({
  fetchTopicEventsWithRetry: vi.fn(async () => null),
  subscribeKernelSessionEvents: vi.fn(() => () => {})
}))

const SID = 'sess-web'
const TOPIC = 'topic-web-citation'

const ev = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ session_id: SID, seq, time: 1000 + seq, type, data }) as unknown as SessionEvent

const userMsg = (seq: number, text: string): SessionEvent =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }] })

const asstMsg = (seq: number, content: unknown[]): SessionEvent =>
  ev(seq, 'assistant/message', {
    message: { role: 'assistant', content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
    usage: { inputTokens: 1, outputTokens: 2 }
  })

const turnEnd = (seq: number): SessionEvent => ev(seq, 'turn/end', { reason: { kind: 'completed' } })

const webSearchMeta = {
  kind: 'web-search',
  results: [
    { title: '结果一', url: 'https://a.example.com/x', content: '正文片段一' },
    { title: '结果二', url: 'https://b.example.com/y', content: '正文片段二' }
  ]
}

describe('web_search 引用载体投影（v0.4 验收轮）', () => {
  it('web-search meta → CITATION 块（response.results 双层包装，websearch 条目可格式化）', async () => {
    vi.mocked(fetchTopicEventsWithRetry).mockResolvedValue([
      userMsg(2, '搜一下'),
      asstMsg(3, [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: '{"query":"q"}' }]),
      ev(4, 'tool/call', { callId: 'c1', name: 'web_search', arguments: '{"query":"q"}' }),
      ev(5, 'tool/result', {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Web results' }], isError: false }
          ]
        },
        meta: webSearchMeta
      }),
      asstMsg(6, [{ type: 'text', text: '答案 [1]' }]),
      turnEnd(7)
    ] as never)
    const result = await loadKernelTopicMessages(TOPIC)
    if (result === null) throw new Error('project 结果为 null')

    const citationBlocks = result.blocks.filter(
      (b) => (b as { type?: string }).type === MessageBlockType.CITATION
    ) as CitationMessageBlock[]
    expect(citationBlocks).toHaveLength(1)

    const citations = formatCitationsFromBlock(citationBlocks[0], new Map())
    expect(citations).toHaveLength(2)
    expect(citations[0]?.type).toBe('websearch')
    expect(citations[0]?.title).toBe('结果一')
    expect(citations[0]?.url).toBe('https://a.example.com/x')
  })
})

describe('同轮多次 web_search 合并（v0.4 验收轮：单一引用卡 + 全局编号）', () => {
  it('两次搜索 → 单一 CITATION 载体（6+6=12 条），无第二张卡', async () => {
    vi.mocked(fetchTopicEventsWithRetry).mockResolvedValue([
      userMsg(2, '搜两次'),
      asstMsg(3, [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: '{"query":"q1"}' }]),
      ev(4, 'tool/call', { callId: 'c1', name: 'web_search', arguments: '{"query":"q1"}' }),
      ev(5, 'tool/result', {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Web results' }], isError: false }
          ]
        },
        meta: {
          kind: 'web-search',
          results: Array.from({ length: 6 }, (_, i) => ({
            title: `一次-${i + 1}`,
            url: `https://a/${i}`,
            content: 'c'
          }))
        }
      }),
      asstMsg(7, [{ type: 'tool-call', id: 'c2', name: 'web_search', arguments: '{"query":"q2"}' }]),
      ev(8, 'tool/call', { callId: 'c2', name: 'web_search', arguments: '{"query":"q2"}' }),
      ev(9, 'tool/result', {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'Web results' }], isError: false }
          ]
        },
        meta: {
          kind: 'web-search',
          results: Array.from({ length: 6 }, (_, i) => ({
            title: `二次-${i + 1}`,
            url: `https://b/${i}`,
            content: 'c'
          }))
        }
      }),
      asstMsg(11, [{ type: 'text', text: '答案' }]),
      turnEnd(12)
    ] as never)
    const result = await loadKernelTopicMessages(TOPIC)
    if (result === null) throw new Error('project 结果为 null')

    const citationBlocks = result.blocks.filter(
      (b) => (b as { type?: string }).type === MessageBlockType.CITATION
    ) as CitationMessageBlock[]
    expect(citationBlocks).toHaveLength(1)
    const citations = formatCitationsFromBlock(citationBlocks[0], new Map())
    expect(citations).toHaveLength(12)
    expect(citations[6]?.title).toBe('二次-1')
  })
})

describe('冻结载体合并回归（真机 15:40 实证：RTK 冻结块上原地赋值抛 TypeError）', () => {
  it('frozen existing carrier → merge returns a NEW block, original untouched, no throw', async () => {
    const { buildSearchCitationBlock } = await import('../kernelChat')
    const first = buildSearchCitationBlock(
      'msg-1',
      { kind: 'web-search', results: [{ title: 'a', url: 'https://a', content: 'c' }] },
      false
    )
    if (first === undefined || first.merged) throw new Error('first call must create a block')
    const frozen = deepFreeze(first.block)

    const result = buildSearchCitationBlock(
      'msg-1',
      { kind: 'web-search', results: [{ title: 'b', url: 'https://b', content: 'c' }] },
      false,
      frozen
    )
    expect(result).toBeDefined()
    if (result === undefined || !result.merged) throw new Error('merge expected')
    const wrapper = result.block.response?.results as { results: Array<{ title: string }> }
    expect(wrapper.results).toHaveLength(2)
    expect(wrapper.results[1]?.title).toBe('b')
    // 原块（冻结）零改动——RTK 冻结面不再被触碰
    const originalWrapper = frozen.response?.results as { results: Array<{ title: string }> }
    expect(originalWrapper.results).toHaveLength(1)
  })
})

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
