import type { Assistant, Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import assistants, { addAssistant, addTopic, updateTopic, updateTopicUpdatedAt } from '../assistants'

/**
 * `assistants/` 在 `store/index.ts` 的 syncList 里，因此同一条 action 会被
 * `src/main/services/StoreSyncService.ts` **原样广播**给 mini 窗，两个窗口各跑一次 reducer。
 * reducer 内 `new Date()` / `new Date().toISOString()` 会让两窗算出不同的 createdAt/updatedAt
 * （侧栏排序、familyRowSignature 都吃 updatedAt）。非确定性值必须在 action 创建时定妥
 * （`prepare`），reducer 只做赋值。
 *
 * 同时钉住 ：updateTopic 不再就地改 action payload，messages 口径与 updateTopics 对齐。
 */
const ASSISTANT_ID = 'assistant-a'

const seed = () => {
  let state = assistants(undefined, { type: '@@INIT' })
  state = assistants(state, addAssistant({ id: ASSISTANT_ID, name: 'a', topics: [] } as unknown as Assistant))
  return state
}

type State = ReturnType<typeof seed>

const topicOf = (state: State, id: string): Topic | undefined =>
  state.assistants.flatMap((assistant) => assistant.topics ?? []).find((topic) => topic.id === id)

const newTopic = (id: string, extra: Partial<Topic> = {}): Topic =>
  ({
    id,
    type: TopicType.Chat,
    assistantId: ASSISTANT_ID,
    name: id,
    ...extra
  }) as Topic

const payloadTopic = (action: { payload: unknown }): Topic => (action.payload as { topic: Topic }).topic

describe('assistants reducers — 跨窗口确定性', () => {
  it('addTopic：时间戳在 action 创建时定妥，两窗执行同一 action 结果一致', () => {
    const action = addTopic({ assistantId: ASSISTANT_ID, topic: newTopic('t1') })
    const stamped = payloadTopic(action)

    // action 自带时间戳（reducer 不再 mint）
    expect(stamped.createdAt).toBeTruthy()
    expect(stamped.createdAt).toBe(stamped.updatedAt)

    const windowA = assistants(seed(), action)
    const windowB = assistants(seed(), action)

    expect(topicOf(windowA, 't1')?.createdAt).toBe(stamped.createdAt)
    expect(topicOf(windowB, 't1')?.createdAt).toBe(stamped.createdAt)
    expect(topicOf(windowB, 't1')?.updatedAt).toBe(stamped.updatedAt)
  })

  it('addTopic：调用方给出的时间戳不被覆盖', () => {
    const action = addTopic({
      assistantId: ASSISTANT_ID,
      topic: newTopic('t1', { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })
    })
    const next = assistants(seed(), action)

    expect(topicOf(next, 't1')?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(topicOf(next, 't1')?.updatedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('updateTopic：updatedAt 来自 payload，reducer 不再就地改 action payload', () => {
    let state = seed()
    state = assistants(
      state,
      addTopic({ assistantId: ASSISTANT_ID, topic: newTopic('t1', { createdAt: 'C', updatedAt: 'C' }) })
    )

    const action = updateTopic({ assistantId: ASSISTANT_ID, topic: { ...topicOf(state, 't1')!, name: '新名' } })
    const stamped = payloadTopic(action)
    const payloadJson = JSON.stringify(action.payload)

    const next = assistants(state, action)

    expect(JSON.stringify(action.payload)).toBe(payloadJson)
    expect(stamped.updatedAt).not.toBe('C')
    expect(topicOf(next, 't1')?.updatedAt).toBe(stamped.updatedAt)
    expect(topicOf(next, 't1')?.name).toBe('新名')
  })

  it('updateTopicUpdatedAt：时间戳来自 payload（广播后两窗一致）', () => {
    let state = seed()
    state = assistants(
      state,
      addTopic({ assistantId: ASSISTANT_ID, topic: newTopic('t1', { createdAt: 'C', updatedAt: 'C' }) })
    )

    const action = updateTopicUpdatedAt({ topicId: 't1' })
    const stamp = (action.payload as { updatedAt: string }).updatedAt
    expect(stamp).toBeTruthy()

    const windowA = assistants(state, action)
    const windowB = assistants(state, action)

    expect(topicOf(windowA, 't1')?.updatedAt).toBe(stamp)
    expect(topicOf(windowB, 't1')?.updatedAt).toBe(stamp)
  })
})

describe('updateTopic — messages 口径对齐 updateTopics', () => {
  it('不碰无关行：不带 messages 的旁行保留原引用，不被加上 messages: []', () => {
    let state = seed()
    state = assistants(
      state,
      addTopic({ assistantId: ASSISTANT_ID, topic: newTopic('t1', { createdAt: 'C', updatedAt: 'C' }) })
    )
    state = assistants(
      state,
      addTopic({ assistantId: ASSISTANT_ID, topic: newTopic('t2', { createdAt: 'C', updatedAt: 'C' }) })
    )

    const next = assistants(
      state,
      updateTopic({ assistantId: ASSISTANT_ID, topic: { ...topicOf(state, 't1')!, name: 'n' } })
    )

    expect(topicOf(next, 't2')).toBe(topicOf(state, 't2'))
    expect(topicOf(next, 't2')?.messages).toBeUndefined()
    expect(topicOf(next, 't1')?.messages).toBeUndefined()
  })

  it('目标行带来的非空 messages 仍被剔除（与 updateTopics 同一口径），且不就地改 payload', () => {
    let state = seed()
    state = assistants(
      state,
      addTopic({ assistantId: ASSISTANT_ID, topic: newTopic('t1', { createdAt: 'C', updatedAt: 'C' }) })
    )

    const incoming = { ...topicOf(state, 't1')!, messages: [{ id: 'm1' }] as unknown as Topic['messages'] }
    const action = updateTopic({ assistantId: ASSISTANT_ID, topic: incoming })
    const next = assistants(state, action)

    expect(topicOf(next, 't1')?.messages).toEqual([])
    // payload 对象本身没被就地改（旧实现会把 messages 改成 []）
    expect(action.payload.topic.messages).toEqual([{ id: 'm1' }])
  })
})
