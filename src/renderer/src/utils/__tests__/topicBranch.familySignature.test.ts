import { type Topic, TopicType } from '@renderer/types'
import type * as TopicBranchModule from '@renderer/utils/topicBranch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `familyRowSignature`（页码条/旁答条的家族缓存失效口径）：
 * 只盖本话题家族的行——与"盖全助手清单"旧口径的区别直接决定页码条会不会被
 * 无关话题的变动拖着反复重取（真机实证的"乱跳"形态之一）。
 *
 * 家族闭包与 `collectSubtreeIds` 共用一份 `parentTopicId → 子行[]` 索引 + 一次 BFS。
 * 本文件的"共父分支 / 父行缺失 / 父行已删"三例是那份索引的正确性契约：索引只要记错一处
 * （覆盖同父的第二个兄弟、把不可达的行拉进家族、把断链的行接到祖辈上），签名立刻变。
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
  // 父→子索引的正确性（索引 + 一次 BFS 替换了逐轮全表扫描）。
  // 下面三例分别钉住"共父的第二个兄弟"、"父行缺失的孤儿"、"父行已删的断链"。
  //
  it('共父的两个分支都在家族里（索引覆盖兄弟会让整条分支消失）', () => {
    const rows = [
      row('root-a'),
      row('b1', 'root-a'),
      row('b2', 'root-a'), // 与 b1 同父：单值索引会覆盖掉它
      row('b1c', 'b1'),
      row('b2c', 'b2'),
      row('root-b'), // 别的家族
      row('other', 'root-b')
    ]
    const sig = familyRowSignature(rows, 'b1c')
    for (const id of ['root-a', 'b1', 'b2', 'b1c', 'b2c']) {
      expect(sig).toContain(id + ':')
    }
    expect(sig).not.toContain('root-b')
    // 五个家族行 → 五段；丢掉共父兄弟时只剩四段
    expect(sig.split('|')).toHaveLength(5)
    // 入口不影响家族：根解析与下溯都走同一份索引
    expect(familyRowSignature(rows, 'root-a')).toBe(sig)
    expect(familyRowSignature(rows, 'b2c')).toBe(sig)
  })

  it('父行缺失的孤儿行不进任何家族；以它为根时家族只有它自己', () => {
    const rows = [row('root-a'), row('b1', 'root-a'), row('orphan', 'missing-parent')]
    const sig = familyRowSignature(rows, 'root-a')
    expect(sig).toContain('root-a')
    expect(sig).toContain('b1:')
    expect(sig).not.toContain('orphan')
    // 断链处即根：签名与"清单里只有这一行"逐字相同
    expect(familyRowSignature(rows, 'orphan')).toBe(familyRowSignature([row('orphan', 'missing-parent')], 'orphan'))
  })

  it('父行已被删除：子树既不在祖辈家族里，也不再认得祖辈', () => {
    const withoutB1 = [row('root-a'), row('b2', 'b1')] // b1 已删，b2 的父悬空
    const rootSig = familyRowSignature(withoutB1, 'root-a')
    expect(rootSig).toContain('root-a')
    expect(rootSig).not.toContain('b2')
    expect(familyRowSignature(withoutB1, 'b2')).toBe(familyRowSignature([row('b2', 'b1')], 'b2'))
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

/**
 * `collectSubtreeIds`（`removeTopic` / `pruneTopics` 的删除闭包）改用与
 * `familyRowSignature` 同一份父→子索引 + 同一次 BFS。这里的断言钉住那条共享路径：
 * 共父分支必须全收、兄弟子树不得互相牵连、断链与成环都必须终止。
 */
describe('collectSubtreeIds（血缘闭包：与家族签名共用同一份父→子索引）', () => {
  const rows = [
    row('root-a'),
    row('b1', 'root-a'),
    row('b2', 'root-a'), // 与 b1 同父
    row('b1c', 'b1'),
    row('b2c', 'b2'),
    row('other-root'),
    row('orphan', 'missing-parent')
  ]

  it('共父的两个分支一次收全（单值索引会漏掉第二个兄弟）', async () => {
    const { collectSubtreeIds } = await freshModule()
    expect([...collectSubtreeIds(rows, ['root-a'])].sort()).toEqual(['b1', 'b1c', 'b2', 'b2c', 'root-a'])
  })

  it('只删一个分支时兄弟子树原样留下', async () => {
    const { collectSubtreeIds } = await freshModule()
    expect([...collectSubtreeIds(rows, ['b1'])].sort()).toEqual(['b1', 'b1c'])
    expect([...collectSubtreeIds(rows, ['b2'])].sort()).toEqual(['b2', 'b2c'])
  })

  it('根不在清单也在结果里；父行缺失的孤儿行不被收进', async () => {
    const { collectSubtreeIds } = await freshModule()
    // 尚未物化的根 id：闭包含它自身，闭包为空也是确定性答案
    expect([...collectSubtreeIds(rows, ['not-materialized'])]).toEqual(['not-materialized'])
    expect(collectSubtreeIds(rows, ['root-a']).has('orphan')).toBe(false)
  })

  it('互为父子的环与自指行都终止（每行只入队一次）', async () => {
    const { collectSubtreeIds } = await freshModule()
    const cyclic = [row('x', 'y'), row('y', 'x'), row('self', 'self')]
    expect([...collectSubtreeIds(cyclic, ['x'])].sort()).toEqual(['x', 'y'])
    expect([...collectSubtreeIds(cyclic, ['self'])]).toEqual(['self'])
  })
})
