import type { RootState } from '@renderer/store'
import { selectGeneratingTopicIds } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

/**
 * 侧栏黄点的**家族折叠**（v0.3.1 第三轮）钉：
 * 重发/旁答的回合在 fork 出的子会话 id 上记账（PENDING/PROCESSING 的 assistant 消息），
 * 侧栏只渲染根行——selectGeneratingTopicIds 的输出必须把子会话折叠成**根 id**，
 * 否则重发流"根行不知道子会话在打字"，黄点全灭（真机验收实证的缺陷）。
 */

function row(id: string, parentTopicId?: string): Topic {
  return {
    id,
    type: TopicType.Chat,
    assistantId: 'a1',
    name: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...(parentTopicId !== undefined ? { parentTopicId } : {})
  }
}

function assistantMessage(id: string, status: Message['status']): Message {
  return { id, role: 'assistant', status } as unknown as Message
}

function buildState(messages: Message[], idsByTopic: Record<string, string[]>, topics: Topic[]): RootState {
  const entities: Record<string, Message> = {}
  for (const message of messages) entities[message.id] = message
  return {
    messages: {
      messageIdsByTopic: idsByTopic,
      entities
    },
    assistants: {
      assistants: [{ id: 'a1', name: 'a', topics } as unknown as Assistant]
    }
  } as unknown as RootState
}

describe('selectGeneratingTopicIds（家族折叠）', () => {
  const topics = [row('root'), row('branch', 'root'), row('deep', 'branch')]

  it('重发流：子分支的回合折到根行（侧栏按 root 查询命中）', () => {
    const state = buildState([assistantMessage('m1', AssistantMessageStatus.PENDING)], { branch: ['m1'] }, topics)
    const generating = selectGeneratingTopicIds(state)
    expect(generating.has('root')).toBe(true)
    expect(generating.has('branch')).toBe(false) // 折叠后 key 域 = 根 id
  })

  it('深层分支（隔多层）同样折到根', () => {
    const state = buildState([assistantMessage('m1', AssistantMessageStatus.PROCESSING)], { deep: ['m1'] }, topics)
    expect(selectGeneratingTopicIds(state).has('root')).toBe(true)
  })

  it('根会话直发：根 id 本身就在集合', () => {
    const state = buildState([assistantMessage('m1', AssistantMessageStatus.PENDING)], { root: ['m1'] }, topics)
    expect(selectGeneratingTopicIds(state).has('root')).toBe(true)
  })

  it('回合结束（SUCCESS）→ 集合为空', () => {
    const state = buildState([assistantMessage('m1', AssistantMessageStatus.SUCCESS)], { branch: ['m1'] }, topics)
    expect(selectGeneratingTopicIds(state).size).toBe(0)
  })

  it('用户消息不触发（只认 assistant 的 PENDING/PROCESSING）', () => {
    const userMessage = { id: 'u1', role: 'user' } as unknown as Message
    const state = buildState([userMessage], { branch: ['u1'] }, topics)
    expect(selectGeneratingTopicIds(state).size).toBe(0)
  })

  it('行尚未入表（异常时序）→ 降级为自身 id，不炸不误折', () => {
    const state = buildState(
      [assistantMessage('m1', AssistantMessageStatus.PENDING)],
      { 'unknown-topic': ['m1'] },
      topics
    )
    const generating = selectGeneratingTopicIds(state)
    expect(generating.has('unknown-topic')).toBe(true)
    expect(generating.size).toBe(1)
  })
})
