import type { Assistant, Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { familyRowSignature } from '@renderer/utils/topicBranch'
import { describe, expect, it } from 'vitest'

import assistants, { addAssistant, addTopic, updateTopic, updateTopicName } from '../assistants'

/**
 * 话题命名落名的**免 bump 专属 action**钉（对话树数字连跳的根治位）。
 * 历史上写名方是 dsh session/title 事件（v0.3.1 定本 action，v0.3.1 拆标题
 * 服务后改由 services/topicNaming.ts 自动命名调用，规则不变）：
 *
 * 名字此前走通用 updateTopic → updatedAt 必 bump → updatedAt 在
 * familyRowSignature（页码条/分支图的家族缓存失效签名）里 → 每次命名都触发
 * 全家族重取，而结构根本没变。标题预算修复（128→2048）让 session/title 第一次
 * 真正开始流动后，该通路持续暴露（真机 2026-09-17）。本测试钉住三件事：
 * ① 名字写进全部持有者副本、其他字段分毫不动；
 * ② 家族签名前后不变（树与标题解耦的语义本身）；
 * ③ 通用 updateTopic 会改签名（绝不能退回去的原因，也是对照面）。
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
  const assistantA: Assistant = {
    id: 'assistant-a',
    name: 'a',
    topics: []
  } as unknown as Assistant
  const assistantB: Assistant = { id: 'assistant-b', name: 'b', topics: [] } as unknown as Assistant

  let state = assistants(undefined, { type: '@@INIT' })
  state = assistants(state, addAssistant(assistantA))
  state = assistants(state, addAssistant(assistantB))
  // 家族：root + fork 子行（A 名下）；污染形态：root 同时被 B 持有一份副本
  state = assistants(
    state,
    addTopic({
      assistantId: 'assistant-a',
      topic: topicRow('root-1', 'assistant-a', { updatedAt: '2026-09-02T00:00:00.000Z' })
    })
  )
  state = assistants(
    state,
    addTopic({
      assistantId: 'assistant-a',
      topic: topicRow('branch-1', 'assistant-a', {
        parentTopicId: 'root-1',
        branchKind: 'resend',
        updatedAt: '2026-09-03T00:00:00.000Z'
      })
    })
  )
  state = assistants(
    state,
    addTopic({ assistantId: 'assistant-b', topic: topicRow('root-1', 'assistant-b', { pinned: true }) })
  )
  return state
}

const allTopicsOf = (state: ReturnType<typeof buildScene>): Topic[] =>
  state.assistants.flatMap((assistant) => assistant.topics ?? [])

describe('updateTopicName（标题落地免 bump）', () => {
  it('名字写进全部持有者副本；updatedAt/branchKind/pinned 等其他字段不动', () => {
    const state = buildScene()
    const next = assistants(state, updateTopicName({ topicId: 'root-1', name: '内核起的标题' }))

    const holders = next.assistants.flatMap((assistant) =>
      (assistant.topics ?? []).filter((row) => row.id === 'root-1')
    )
    expect(holders).toHaveLength(2) // A 正主 + B 污染副本，全部写入（v0.3.0-5 语义保持）
    for (const row of holders) expect(row.name).toBe('内核起的标题')

    const bCopy = holders.find((row) => row.assistantId === 'assistant-b')
    expect(bCopy?.pinned).toBe(true) // 其他字段原样
    expect(bCopy?.updatedAt).toBe('2026-09-01T00:00:00.000Z')

    const branch = next.assistants.flatMap((assistant) => assistant.topics ?? []).find((row) => row.id === 'branch-1')
    expect(branch?.name).toBe('branch-1') // 家族内无关行不动
    expect(branch?.branchKind).toBe('resend')
  })

  it('家族签名前后不变（树与标题解耦的语义本身）', () => {
    const state = buildScene()
    const beforeRoot = familyRowSignature(allTopicsOf(state), 'root-1')
    const beforeBranch = familyRowSignature(allTopicsOf(state), 'branch-1')

    const next = assistants(state, updateTopicName({ topicId: 'root-1', name: '内核起的标题' }))

    expect(familyRowSignature(allTopicsOf(next), 'root-1')).toBe(beforeRoot)
    expect(familyRowSignature(allTopicsOf(next), 'branch-1')).toBe(beforeBranch)
  })

  it('对照面：通用 updateTopic 落标题会改家族签名（不能退回的路径）', () => {
    const state = buildScene()
    const before = familyRowSignature(allTopicsOf(state), 'root-1')

    const row = allTopicsOf(state).find((candidate) => candidate.id === 'root-1')
    expect(row).toBeDefined()
    const next = assistants(
      state,
      updateTopic({ assistantId: 'assistant-a', topic: { ...row!, name: '内核起的标题' } })
    )

    expect(familyRowSignature(allTopicsOf(next), 'root-1')).not.toBe(before)
  })

  it('同名重复写入 → 状态不变（immer 无 mutation，不触发无谓通知）', () => {
    const state = assistants(buildScene(), updateTopicName({ topicId: 'root-1', name: '标题' }))
    const again = assistants(state, updateTopicName({ topicId: 'root-1', name: '标题' }))
    expect(again).toBe(state)

    const unknownTarget = assistants(state, updateTopicName({ topicId: 'no-such-row', name: 'x' }))
    expect(unknownTarget).toBe(state)
  })
})
