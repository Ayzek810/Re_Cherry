import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { buildParallelAnswerMap, type ParallelChildInfo } from '../useParallelAnswers'

/** 构造最小 Message 形状（builder 只读 role/askId/id）。 */
function msg(id: string, role: 'user' | 'assistant', askId: string): Message {
  return { id, role, askId } as unknown as Message
}

function stateOf(entities: Message[], messageIdsByTopic: Record<string, string[]>) {
  const record: Record<string, Message | undefined> = {}
  for (const m of entities) record[m.id] = m
  return { messages: { entities: record, messageIdsByTopic } }
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
