import { owningAssistantOfTopic } from '@renderer/store/assistants'
import type { Assistant, Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { describe, expect, it } from 'vitest'

/**
 * 话题行归属的**唯一权威判定**（页码条/旁答条缺陷的语义钉）：
 *
 * 背景（真机实证）：隔离对账会移动行、对账前的历史复制留下污染行——行对象上的
 * `assistantId` **字段**可能与实际持有它的助手清单不一致。任何按字段找助手的消费方
 * （家族刷新签名 / branchKind 判定 / 切页物化）拿到的是错误清单，页码因此与分支图
 * 越走越偏。成员归属（"哪份清单里有这行"）才是事实。
 */

function assistant(id: string, topicIds: string[]): Assistant {
  return {
    id,
    name: id,
    topics: topicIds.map(
      (tid): Topic => ({
        id: tid,
        type: TopicType.Chat,
        assistantId: id,
        name: tid,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        messages: []
      })
    ),
    model: { id: 'model-1', provider: 'p1' }
  } as unknown as Assistant
}

describe('owningAssistantOfTopic（成员归属权威）', () => {
  it('行在某助手清单里 → 返回该助手（字段一致时无差别）', () => {
    const a = assistant('a', ['topic-1', 'topic-2'])
    const b = assistant('b', ['topic-3'])
    expect(owningAssistantOfTopic([a, b], 'topic-2')?.id).toBe('a')
    expect(owningAssistantOfTopic([a, b], 'topic-3')?.id).toBe('b')
  })

  it('字段指向别的助手、但行实际在 A 名下 → 归属 A（成员归属压过字段）', () => {
    const a = assistant('a', ['topic-1'])
    const b = assistant('b', [])
    // 模拟历史污染：行对象的 assistantId 字段是旧归属 b，但行躺在 a 的清单里
    ;(a.topics[0] as Topic & { assistantId: string }).assistantId = 'b'
    expect(owningAssistantOfTopic([a, b], 'topic-1')?.id).toBe('a')
  })

  it('任何助手都没有该行（已删除/尚未物化）→ undefined，调用方须自行兜底', () => {
    const a = assistant('a', [])
    expect(owningAssistantOfTopic([a], 'topic-gone')).toBeUndefined()
    expect(owningAssistantOfTopic([], 'topic-gone')).toBeUndefined()
  })

  it('脏数据（同一 id 被两个助手持有时）→ 返回先持有者（清单顺序），不抛错', () => {
    const a = assistant('a', ['dup'])
    const b = assistant('b', ['dup'])
    expect(owningAssistantOfTopic([a, b], 'dup')?.id).toBe('a')
    expect(owningAssistantOfTopic([b, a], 'dup')?.id).toBe('b')
  })

  it('topics 字段缺失/非数组的助手 → 视为空清单，不影响其他助手', () => {
    const broken = { id: 'broken', name: 'x' } as unknown as Assistant
    const b = assistant('b', ['topic-1'])
    expect(owningAssistantOfTopic([broken, b], 'topic-1')?.id).toBe('b')
    expect(owningAssistantOfTopic([broken], 'topic-1')).toBeUndefined()
  })
})
