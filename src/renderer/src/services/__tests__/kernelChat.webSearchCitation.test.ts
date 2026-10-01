/**
 * v0.4 验收轮：网络搜索引用载体投影守门（用户反馈"网络搜索没有清单卡"）。
 * web-search meta（presentationMeta 通道）→ CITATION 载体块 → formatCitationsFromBlock
 * 应产出 websearch 引用条目（与 knowledge 形态同管线）。历史还原路径投影，直播同构。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { fetchTopicEventsWithRetry } from '@renderer/services/kernelEventStream'
import { formatCitationsFromBlock } from '@renderer/store/messageBlock'
import type { KnowledgeReference } from '@renderer/types/knowledge'
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

/**
 * W4-1：知识库引用与 web 搜索不对称——web 分支会合并进同一载体，knowledge 分支每次都新建，
 * 于是一轮两次检索出现两个载体、各自从 1 编号；而渲染层只取 `citationReferences[0]`，
 * 第二段正文的 [n] 会对到第一个载体里的错误条目。本组钉住"两来源同构"。
 */
describe('知识库载体合并（W4-1：与 web 搜索同构）', () => {
  const ref = (id: number, sourceUrl: string) =>
    ({ id, content: `content-${id}`, sourceUrl, type: 'file' }) as unknown as KnowledgeReference

  it('第二次检索并入同一载体：条目拼接、块 id 不变、冻结原块零改动', async () => {
    const { buildSearchCitationBlock } = await import('../kernelChat')
    const first = buildSearchCitationBlock('msg-k', { kind: 'knowledge', results: [ref(1, 'C:/docs/a.md')] }, false)
    if (first === undefined || first.merged) throw new Error('first call must create a block')
    const frozen = deepFreeze(first.block)

    const result = buildSearchCitationBlock(
      'msg-k',
      { kind: 'knowledge', results: [ref(2, 'C:/docs/b.md')] },
      false,
      frozen
    )

    expect(result).toBeDefined()
    if (result === undefined || !result.merged) throw new Error('merge expected')
    expect(result.block.knowledge).toHaveLength(2)
    expect(result.block.knowledge?.[1]?.sourceUrl).toBe('C:/docs/b.md')
    // 同一个载体块 id：渲染层只取 citationReferences[0]，换 id 就等于丢掉第一段正文的引用
    expect(result.block.id).toBe(frozen.id)
    // 冻结的原块零改动（并入 store 的块被冻结，原地 push 会抛错）
    expect(frozen.knowledge).toHaveLength(1)
  })

  it('跨来源不合并：web 载体收到 knowledge meta → 另建新载体（各来源只认自己的载荷）', async () => {
    const { buildSearchCitationBlock } = await import('../kernelChat')
    const web = buildSearchCitationBlock(
      'msg-mix',
      { kind: 'web-search', results: [{ title: 'a', url: 'https://a', content: 'c' }] },
      false
    )
    if (web === undefined || web.merged) throw new Error('web block expected')

    const result = buildSearchCitationBlock(
      'msg-mix',
      { kind: 'knowledge', results: [ref(1, 'C:/docs/a.md')] },
      false,
      web.block
    )

    expect(result).toBeDefined()
    if (result === undefined || result.merged) throw new Error('new knowledge block expected')
    expect(result.block.knowledge).toHaveLength(1)
  })

  it('还原路径同构：日志里两次 knowledge_search → 仍只有一个载体（条目拼接）', async () => {
    const knowledgeMeta = (prefix: string, count: number) => ({
      kind: 'knowledge',
      results: Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        content: `${prefix}-片段${i + 1}`,
        sourceUrl: `C:/docs/${prefix}.md`,
        type: 'file'
      }))
    })
    const toolResult = (seq: number, callId: string, meta: unknown) =>
      ev(seq, 'tool/result', {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'KB' }], isError: false }
          ]
        },
        meta
      })
    vi.mocked(fetchTopicEventsWithRetry).mockResolvedValue([
      userMsg(2, '查库两次'),
      asstMsg(3, [{ type: 'tool-call', id: 'k1', name: 'knowledge_search', arguments: '{"query":"q1"}' }]),
      ev(4, 'tool/call', { callId: 'k1', name: 'knowledge_search', arguments: '{"query":"q1"}' }),
      toolResult(5, 'k1', knowledgeMeta('一次', 2)),
      asstMsg(7, [{ type: 'tool-call', id: 'k2', name: 'knowledge_search', arguments: '{"query":"q2"}' }]),
      ev(8, 'tool/call', { callId: 'k2', name: 'knowledge_search', arguments: '{"query":"q2"}' }),
      toolResult(9, 'k2', knowledgeMeta('二次', 3)),
      asstMsg(11, [{ type: 'text', text: '答案 [1]' }]),
      turnEnd(12)
    ] as never)
    const result = await loadKernelTopicMessages(TOPIC)
    if (result === null) throw new Error('project 结果为 null')

    const citationBlocks = result.blocks.filter(
      (b) => (b as { type?: string }).type === MessageBlockType.CITATION
    ) as CitationMessageBlock[]
    // 旧实现在还原路径上只对 web 搜索传 existing ⇒ 知识库每次新建 → 这里会是 2 个载体
    expect(citationBlocks).toHaveLength(1)
    expect(citationBlocks[0]?.knowledge).toHaveLength(5)
    const citations = formatCitationsFromBlock(citationBlocks[0], new Map())
    expect(citations).toHaveLength(5)
    expect(citations.every((c) => c.type === 'knowledge')).toBe(true)
    expect(citations[2]?.title).toBe('C:/docs/二次.md')
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
