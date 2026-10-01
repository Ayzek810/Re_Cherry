import type { RootState } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { buildParallelAnswerMap, type ParallelChildInfo, selectParallelAnswerMap } from '../useParallelAnswers'

/** 构造最小 Message 形状（builder 只读 role/askId/id）。 */
function msg(id: string, role: 'user' | 'assistant', askId: string): Message {
  return { id, role, askId } as unknown as Message
}

function stateOf(entities: Message[], messageIdsByTopic: Record<string, string[]>) {
  const record: Record<string, Message | undefined> = {}
  for (const m of entities) record[m.id] = m
  return { messages: { entities: record, messageIdsByTopic } }
}

/** 选择器只读 `messages.entities` 与 `messages.messageIdsByTopic`，其余切片按"更不相关"灌空对象。 */
function rootOf(messages: ReturnType<typeof stateOf>['messages']): RootState {
  return { messages } as unknown as RootState
}

describe('buildParallelAnswerMap（旁答归并 = v1 卡片组数据源）', () => {
  it('按 anchorQuestionId 归并子会话自有轮的回答；种子拷贝与其余消息不进', () => {
    // 子会话 C：日志含种子拷贝（P 的历史）+ 自有轮（问题拷贝 + 旁答）
    const childMessages: Message[] = [
      msg('kernel-P-1', 'user', 'kernel-P-1'), // 种子：P 的轮 0 问题拷贝
      msg('kernel-P-2', 'assistant', 'kernel-P-1'), // 种子：P 的轮 0 回答拷贝
      msg('kernel-C-3', 'user', 'kernel-C-3'), // 自有轮：问题拷贝
      msg('kernel-C-4', 'assistant', 'kernel-C-3'), // 旁答（模型 A）
      msg('kernel-C-5', 'assistant', 'kernel-C-3') // 旁答（同轮第二段，异常防御下也按序并入）
    ]
    const children: ParallelChildInfo[] = [{ id: 'C', anchorQuestionId: 'kernel-P-2', copyQuestionId: 'kernel-C-3' }]
    const map = buildParallelAnswerMap(stateOf(childMessages, { C: childMessages.map((m) => m.id) }), children)
    expect(map.get('kernel-P-2')?.map((m) => m.id)).toEqual(['kernel-C-4', 'kernel-C-5'])
  })

  it('同锚多 parallel 子会话按 children 顺序（= fork 创建序）追加', () => {
    const c1: Message[] = [msg('kernel-C1-1', 'user', 'kernel-C1-1'), msg('kernel-C1-2', 'assistant', 'kernel-C1-1')]
    const c2: Message[] = [msg('kernel-C2-1', 'user', 'kernel-C2-1'), msg('kernel-C2-2', 'assistant', 'kernel-C2-1')]
    const children: ParallelChildInfo[] = [
      { id: 'C1', anchorQuestionId: 'kernel-P-2', copyQuestionId: 'kernel-C1-1' },
      { id: 'C2', anchorQuestionId: 'kernel-P-2', copyQuestionId: 'kernel-C2-1' }
    ]
    const map = buildParallelAnswerMap(
      stateOf([...c1, ...c2], { C1: c1.map((m) => m.id), C2: c2.map((m) => m.id) }),
      children
    )
    expect(map.get('kernel-P-2')?.map((m) => m.id)).toEqual(['kernel-C1-2', 'kernel-C2-2'])
  })

  it('尚未入 store 的子会话（重启未还原）不产出条目', () => {
    const children: ParallelChildInfo[] = [{ id: 'C', anchorQuestionId: 'kernel-P-2', copyQuestionId: 'kernel-C-3' }]
    const map = buildParallelAnswerMap(stateOf([], {}), children)
    expect(map.size).toBe(0)
  })
})

/**
 * hook 的订阅粒度与返回引用稳定性。
 *
 * 订阅面从 `state.messages`（切片根，任何 messages reducer 都会换引用）收窄为
 * `entities` + `messageIdsByTopic`；并保证旁答集合内容不变时返回**同一个 Map 引用**——
 * 它是 `Messages.tsx` 里 `groupedMessages` 的 useMemo 依赖，换引用就会让消息区整棵重渲。
 */
describe('selectParallelAnswerMap（细粒度订阅 + 内容稳定引用）', () => {
  const children: ParallelChildInfo[] = [{ id: 'C', anchorQuestionId: 'kernel-P-2', copyQuestionId: 'kernel-C-3' }]

  it('无 parallel 子会话时短路成模块级空 Map（引用恒定）', () => {
    const state = rootOf(stateOf([msg('a', 'assistant', 'a')], { P: ['a'] }).messages)
    expect(selectParallelAnswerMap(state, [])).toBe(selectParallelAnswerMap(state, []))
    expect(selectParallelAnswerMap(state, []).size).toBe(0)
  })

  it('无关话题的消息内容变化（entities 换引用）不改变返回的 Map 引用', () => {
    const childAnswers = [msg('kernel-C-4', 'assistant', 'kernel-C-3')]
    const idsByTopic = { C: ['kernel-C-4'], P: ['kernel-P-1', 'kernel-P-2'] }
    const entitiesA: Record<string, Message | undefined> = {
      'kernel-C-4': childAnswers[0],
      'kernel-P-1': msg('kernel-P-1', 'user', 'kernel-P-1')
    }
    const entitiesB: Record<string, Message | undefined> = {
      ...entitiesA,
      // 旁答内容变了（同一实体换引用）——这是流式 tick 的真实形态。
      'kernel-C-4': { ...childAnswers[0] } as Message,
      'kernel-P-9': msg('kernel-P-9', 'assistant', 'kernel-P-1')
    }

    const first = selectParallelAnswerMap(rootOf({ entities: entitiesA, messageIdsByTopic: idsByTopic }), children)
    expect(first.get('kernel-P-2')?.map((m) => m.id)).toEqual(['kernel-C-4'])

    // 内容等价（逐元素同一引用）→ 保持旧 Map，`groupedMessages` 不重算。
    const sameAgain = selectParallelAnswerMap(
      rootOf({ entities: { ...entitiesA }, messageIdsByTopic: idsByTopic }),
      children
    )
    expect(sameAgain).toBe(first)

    // 旁答实体换了引用 → 内容确实变了，必须给出新 Map（否则卡片永远显示旧回答）。
    const changed = selectParallelAnswerMap(rootOf({ entities: entitiesB, messageIdsByTopic: idsByTopic }), children)
    expect(changed).not.toBe(first)
    expect(changed.get('kernel-P-2')?.map((m) => m.id)).toEqual(['kernel-C-4'])
  })

  it('子会话新出现旁答时产出新 Map（缓存不吞掉真实变化）', () => {
    const idsByTopic = { C: ['kernel-C-3', 'kernel-C-4'], P: ['kernel-P-2'] }
    const entities: Record<string, Message | undefined> = {
      'kernel-C-4': msg('kernel-C-4', 'assistant', 'kernel-C-3')
    }
    const before = selectParallelAnswerMap(rootOf({ entities, messageIdsByTopic: idsByTopic }), children)
    expect(before.size).toBe(1)

    const entitiesAfter: Record<string, Message | undefined> = {
      ...entities,
      'kernel-C-5': msg('kernel-C-5', 'assistant', 'kernel-C-3')
    }
    const after = selectParallelAnswerMap(
      rootOf({
        entities: entitiesAfter,
        messageIdsByTopic: { ...idsByTopic, C: ['kernel-C-3', 'kernel-C-4', 'kernel-C-5'] }
      }),
      children
    )
    expect(after).not.toBe(before)
    expect(after.get('kernel-P-2')?.map((m) => m.id)).toEqual(['kernel-C-4', 'kernel-C-5'])
  })
})
