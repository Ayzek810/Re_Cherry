import type { Assistant, Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { familyRowSignature } from '@renderer/utils/topicBranch'
import { describe, expect, it } from 'vitest'

import assistants, { addAssistant, addTopic, moveTopicToHead } from '../assistants'

/**
 * 发送浮顶（v0.3.1 验收轮）action 钉：
 * ① 子行请求搬的是**家族根**（侧栏只显示根行）；
 * ② 其余行保持相对顺序（数组序写入，不整组洗牌）；
 * ③ 只动位置：字段/家族签名前后不变（位置不是"活动"——同 updateTopicName 的免 bump 教义）；
 * ④ 全持有者写（多持有污染行一份都不悬空）；
 * ⑤ 已在头部/未知行 → no-op（immer 返回同一引用）。
 */

function topicRow(id: string, assistantId: string, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    type: TopicType.Chat,
    assistantId,
    name: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...extra
  }
}

function buildScene() {
  const assistantA: Assistant = { id: 'assistant-a', name: 'a', topics: [] } as unknown as Assistant
  const assistantB: Assistant = { id: 'assistant-b', name: 'b', topics: [] } as unknown as Assistant

  let state = assistants(undefined, { type: '@@INIT' })
  state = assistants(state, addAssistant(assistantA))
  state = assistants(state, addAssistant(assistantB))
  // A 名下家族：root-1 + root-2 + fork 子行 branch-1（addTopic 头插 → 数组序 [branch-1, root-2, root-1]）
  state = assistants(state, addTopic({ assistantId: 'assistant-a', topic: topicRow('root-1', 'assistant-a') }))
  state = assistants(
    state,
    addTopic({
      assistantId: 'assistant-a',
      topic: topicRow('root-2', 'assistant-a', { updatedAt: '2026-09-05T00:00:00.000Z' })
    })
  )
  state = assistants(
    state,
    addTopic({
      assistantId: 'assistant-a',
      topic: topicRow('branch-1', 'assistant-a', { parentTopicId: 'root-1', branchKind: 'resend' })
    })
  )
  // B 名下污染持有：root-1 副本（中部）+ root-9（数组序 [root-9, root-1]）
  state = assistants(
    state,
    addTopic({ assistantId: 'assistant-b', topic: topicRow('root-1', 'assistant-b', { pinned: true }) })
  )
  state = assistants(state, addTopic({ assistantId: 'assistant-b', topic: topicRow('root-9', 'assistant-b') }))
  return state
}

const idsOf = (state: ReturnType<typeof buildScene>, assistantId: string): string[] =>
  (state.assistants.find((assistant) => assistant.id === assistantId)?.topics ?? []).map((row) => row.id)

describe('moveTopicToHead（发送浮顶：数组序写入）', () => {
  it('子行请求 → 家族根浮到头部；其余行保持相对顺序；全持有者在 concert 写入', () => {
    const state = buildScene()
    expect(idsOf(state, 'assistant-a')).toEqual(['branch-1', 'root-2', 'root-1'])
    expect(idsOf(state, 'assistant-b')).toEqual(['root-9', 'root-1'])

    // 用户正浏览 branch-1（分支视图）里发送 → 搬 root-1
    const next = assistants(state, moveTopicToHead({ topicId: 'branch-1' }))

    expect(idsOf(next, 'assistant-a')).toEqual(['root-1', 'branch-1', 'root-2'])
    expect(idsOf(next, 'assistant-b')).toEqual(['root-1', 'root-9']) // 污染副本同步浮顶
  })

  it('只动位置：字段与家族签名前后不变（位置不是活动）', () => {
    const state = buildScene()
    const beforeSig = familyRowSignature(
      state.assistants.flatMap((assistant) => assistant.topics ?? []),
      'root-1'
    )
    const beforeRow = state.assistants.flatMap((assistant) => assistant.topics ?? []).find((row) => row.id === 'root-1')

    const next = assistants(state, moveTopicToHead({ topicId: 'root-2' }))

    const afterRow = next.assistants.flatMap((assistant) => assistant.topics ?? []).find((row) => row.id === 'root-1')
    expect(afterRow?.pinned).toBe(beforeRow?.pinned)
    expect(afterRow?.updatedAt).toBe(beforeRow?.updatedAt)
    expect(afterRow).toEqual(beforeRow) // 全字段原样
    expect(
      familyRowSignature(
        next.assistants.flatMap((assistant) => assistant.topics ?? []),
        'root-1'
      )
    ).toBe(beforeSig)
    expect(idsOf(next, 'assistant-a')).toEqual(['root-2', 'branch-1', 'root-1'])
  })

  it('已在头部 → no-op（同一引用）；未知行 → no-op', () => {
    const state = buildScene()
    const moved = assistants(state, moveTopicToHead({ topicId: 'root-1' }))
    expect(idsOf(moved, 'assistant-a')[0]).toBe('root-1')

    const again = assistants(moved, moveTopicToHead({ topicId: 'root-1' }))
    expect(again).toBe(moved) // 两个持有者都已头部 → 零写入

    const unknown = assistants(moved, moveTopicToHead({ topicId: 'no-such-row' }))
    expect(unknown).toBe(moved)
  })
})
