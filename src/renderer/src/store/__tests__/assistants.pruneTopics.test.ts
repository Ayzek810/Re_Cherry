import type { Topic } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

/**
 * `pruneTopics`（v0.3.0-2 目标 B）：以内核对账结果剪除渲染层陈旧行。
 *
 * 验收口径（`report.md` §3.4）：
 * - B-4：被剪的行不再存在，且**同级/其他行的渲染层私有字段不受影响**（`pinned`/`prompt`/
 *   `lastViewedBranchId` 这类只归渲染层的字段不因为"对账"而被改写）；
 * - 血缘：剪一个根行时其 fork 后代一并消失（内核删除根时已递归清掉子会话）。
 */
vi.mock('@renderer/hooks/useTopic', () => ({ TopicManager: { removeTopic: vi.fn() } }))

const { default: assistantsReducer, pruneTopics } = await import('../assistants')

function topic(id: string, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    assistantId: 'assistant-1',
    name: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...extra
  }
}

/** reducer 的 state 参数可含 undefined（RTK 约定），测试里统一用非空形态。 */
type AssistantsStateLike = NonNullable<Parameters<typeof assistantsReducer>[0]>

function stateWith(topics: Topic[]): AssistantsStateLike {
  return {
    defaultAssistant: { id: 'default', topics: [] },
    assistants: [{ id: 'assistant-1', topics }],
    tagsOrder: [],
    collapsedTags: {},
    presets: []
  } as unknown as AssistantsStateLike
}

const idsOf = (state: AssistantsStateLike): string[] => (state.assistants[0].topics ?? []).map((row: Topic) => row.id)

describe('assistants/pruneTopics', () => {
  it('剪掉的根行及其 fork 后代一起消失，其他行原样保留', () => {
    const next = assistantsReducer(
      stateWith([
        topic('keep', { pinned: true, prompt: '话题提示词', lastViewedBranchId: 'keep-child' }),
        topic('keep-child', { parentTopicId: 'keep' }),
        topic('stale'),
        topic('stale-child', { parentTopicId: 'stale' }),
        topic('stale-grandchild', { parentTopicId: 'stale-child' })
      ]),
      pruneTopics({ assistantId: 'assistant-1', topicIds: ['stale'] })
    )

    expect(idsOf(next)).toEqual(['keep', 'keep-child'])
    // 渲染层私有字段不被对账触碰（B-4）
    expect(next.assistants[0].topics[0]).toMatchObject({
      pinned: true,
      prompt: '话题提示词',
      lastViewedBranchId: 'keep-child'
    })
  })

  it('空列表是 no-op（对账在没有陈旧行时不得产生任何变更）', () => {
    const before = stateWith([topic('a')])
    const next = assistantsReducer(before, pruneTopics({ assistantId: 'assistant-1', topicIds: [] }))
    expect(next).toBe(before)
  })

  it('只作用于目标助手', () => {
    const state = {
      defaultAssistant: { id: 'default', topics: [] },
      assistants: [
        { id: 'assistant-1', topics: [topic('a')] },
        { id: 'assistant-2', topics: [topic('a', { assistantId: 'assistant-2' })] }
      ],
      tagsOrder: [],
      collapsedTags: {},
      presets: []
    } as unknown as AssistantsStateLike

    const next = assistantsReducer(state, pruneTopics({ assistantId: 'assistant-1', topicIds: ['a'] }))

    expect(next.assistants[0].topics).toHaveLength(0)
    expect(next.assistants[1].topics).toHaveLength(1)
  })
})
