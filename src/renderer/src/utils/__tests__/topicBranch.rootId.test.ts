import type { Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { rootTopicIdOf, rootTopicOf } from '@renderer/utils/topicBranch'
import { describe, expect, it } from 'vitest'

/**
 * 家族根解析（v0.3.1 第三轮）钉：
 * - rootTopicIdOf（id 场景：selector/事件投影——起查行必须在表内）
 * - rootTopicOf（对象在手场景：HomePage/Topics——行不在清单也能从对象自身上溯）
 *
 * 这两个入口是侧栏灯"家族折叠"的地基：fork 子会话的生成/未读信号要折到根行，
 * 解析错一层灯就照错行（或直接照不到——重发流灯全灭的真根因）。
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

describe('rootTopicIdOf（id → 根 id，行须在表内）', () => {
  const rows = [row('root'), row('branch', 'root'), row('deep', 'branch'), row('lone-root')]

  it('多层血缘上溯到根（deep → branch → root）', () => {
    expect(rootTopicIdOf('deep', rows)).toBe('root')
  })

  it('直接子行上溯一层到根', () => {
    expect(rootTopicIdOf('branch', rows)).toBe('root')
  })

  it('根行返回自身；另一个根不串门', () => {
    expect(rootTopicIdOf('root', rows)).toBe('root')
    expect(rootTopicIdOf('lone-root', rows)).toBe('lone-root')
  })

  it('起查行不在表内 → 返回自身 id（无害降级：照不亮但不炸）', () => {
    expect(rootTopicIdOf('not-in-table', rows)).toBe('not-in-table')
  })

  it('中间断链 → 停在最后已知祖先', () => {
    const orphan = row('orphan', 'missing-parent')
    expect(rootTopicIdOf('orphan', [orphan, ...rows])).toBe('orphan')
  })

  it('血缘环不死循环（a→b→a）', () => {
    const cyclic = [row('a', 'b'), row('b', 'a')]
    expect(rootTopicIdOf('a', cyclic)).toBe('a')
  })
})

describe('rootTopicOf（对象在手 → 根行对象）', () => {
  const rows = [row('root'), row('branch', 'root')]

  it('行不在清单也能从对象自身上溯（新 fork 分支 + 调用方旧帧清单的时序场景）', () => {
    const freshChild = row('fresh', 'branch')
    const root = rootTopicOf(freshChild, rows)
    expect(root.id).toBe('root')
  })

  it('在清单内的行正常上溯并返回根行对象', () => {
    const root = rootTopicOf(rows[1], rows)
    expect(root.id).toBe('root')
  })
})
