import { type Topic, TopicType } from '@renderer/types'
import type * as TopicBranchModule from '@renderer/utils/topicBranch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `familyRowSignature`（页码条/旁答条的家族缓存失效口径）：
 * 只盖本话题家族的行——与"盖全助手清单"旧口径的区别直接决定页码条会不会被
 * 无关话题的变动拖着反复重取（真机实证的"乱跳"形态之一）。
 */

function row(id: string, parentTopicId?: string, updatedAt = '2026-09-01T00:00:00.000Z'): Topic {
  return {
    id,
    type: TopicType.Chat,
    assistantId: 'a1',
    name: id,
    createdAt: updatedAt,
    updatedAt,
    messages: [],
    ...(parentTopicId !== undefined ? { parentTopicId } : {})
  } as Topic
}

async function freshModule(): Promise<typeof TopicBranchModule> {
  vi.resetModules()
  return await import('@renderer/utils/topicBranch')
}

describe('familyRowSignature（家族域签名）', () => {
  let familyRowSignature: (typeof TopicBranchModule)['familyRowSignature']

  beforeEach(async () => {
    ;({ familyRowSignature } = await freshModule())
  })

  it('只含本家族的行：无关话题（别的话题的根/分支）不进签名', () => {
    const topics = [
      row('root-a'),
      row('b1', 'root-a'),
      row('b2', 'b1'), // 隔层后代，仍属家族
      row('root-b'), // 别的家族
      row('other', 'root-b')
    ]
    const sig = familyRowSignature(topics, 'b2')
    expect(sig).toContain('root-a')
    expect(sig).toContain('b1:')
    expect(sig).toContain('b2:')
    expect(sig).not.toContain('root-b')
    expect(sig).not.toContain('other')
    // 自身即根：家族 = 自己 + 后代
    const sigRoot = familyRowSignature(topics, 'root-a')
    expect(sigRoot).toBe(sig)
  })

  it('无关话题的 updatedAt 变动不改变本家族签名；家族内行变动才改变', () => {
    const base = [row('root-a'), row('b1', 'root-a'), row('root-b')]
    const before = familyRowSignature(base, 'b1')
    // 别的话题动 → 签名不变（这就是修复点：不再被无关变动推翻缓存）
    const unrelatedChanged = familyRowSignature(
      [row('root-a'), row('b1', 'root-a'), row('root-b', undefined, '2099-01-01T00:00:00.000Z')],
      'b1'
    )
    expect(unrelatedChanged).toBe(before)
    // 家族内行动 → 签名变（缓存正确失效）
    const ownChanged = familyRowSignature(
      [row('root-a', undefined, '2099-01-01T00:00:00.000Z'), row('b1', 'root-a'), row('root-b')],
      'b1'
    )
    expect(ownChanged).not.toBe(before)
  })

  it('branchKind 变动参与签名（regenerate 合并判定变化须失效缓存）', () => {
    const base = [row('root-a'), row('b1', 'root-a')]
    const before = familyRowSignature(base, 'b1')
    const kinded = familyRowSignature(
      [{ ...row('b1', 'root-a'), branchKind: 'regenerate' } as Topic, row('root-a')],
      'b1'
    )
    expect(kinded).not.toBe(before)
  })

  it('行不在清单（已删/未物化）→ 空串（调用方空签名=不重取）', () => {
    expect(familyRowSignature([row('root-a')], 'gone')).toBe('')
  })

  //
  // branchKindsOf（跨助手联合 kind 表，首个有值获胜）：
  // 页码条/旁答条/分支图三家共用同一份——kindless 重复行（历史跨助手物化误建）
  // 无论排在联合序列的哪一侧，都不能遮蔽带 kind 的正主。
  //
  it('branchKindsOf：kindless 副本在前也不遮蔽正主的 kind（两种顺序都成立）', async () => {
    const { branchKindsOf } = await freshModule()
    const kindled = { ...row('b1', 'root-a'), branchKind: 'regenerate' } as Topic
    const kindless = row('b1', 'root-a') // 同 id 的无 kind 副本
    // 副本在前（如联合序列里 kindless 助手先出现）
    expect(branchKindsOf([kindless, kindled, row('root-a')]).b1).toBe('regenerate')
    // 正主在前（常规序）
    expect(branchKindsOf([kindled, kindless, row('root-a')]).b1).toBe('regenerate')
  })

  it('branchKindsOf：两份都有值时取首个（清单序确定），缺失返回 undefined', async () => {
    const { branchKindsOf } = await freshModule()
    const first = { ...row('b1', 'root-a'), branchKind: 'resend' } as Topic
    const second = { ...row('b1', 'root-a'), branchKind: 'regenerate' } as Topic
    const kinds = branchKindsOf([first, second])
    expect(kinds.b1).toBe('resend')
    expect(kinds['b2']).toBeUndefined()
  })
})
