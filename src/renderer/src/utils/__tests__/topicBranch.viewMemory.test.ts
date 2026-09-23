/**
 * 家族浏览记忆的落点解析（v0.3.3 修复"重进话题落回报错分支"）。
 *
 * 真机证据（部署实例 localStorage，2026-09-23）：话题 `aa378583…` 首轮 403 报错后，
 * 用户连着生成了两个 `regenerate` 分支（14:12:52 / 14:13:13），分支图里都能看到，
 * 但**根行的 `lastViewedBranchId` 始终为空**（根行 updatedAt 停在报错那一刻），
 * 于是重进话题只能回落到根 = 报错那一轮。
 *
 * 本测试钉住根因：解析必须以 **store 现读的清单** 为准，且派发目标必须是**实际持有根行的助手**。
 */
import type { Assistant, Topic } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { recallLastViewedBranch, resolveTopicViewMemory } from '../topicBranch'

const topic = (id: string, overrides: Partial<Topic> = {}): Topic =>
  ({ id, type: 'chat', assistantId: 'a1', name: id, createdAt: '', updatedAt: '', messages: [], ...overrides }) as Topic

const assistant = (id: string, topics: Topic[]): Assistant =>
  ({ id, name: id, topics, settings: {} }) as unknown as Assistant

describe('resolveTopicViewMemory', () => {
  it('刚 fork 的分支（父行只在 store 里、不在调用方闭包清单里）→ 记忆落在根行上，值 = 分支 id', () => {
    const root = topic('root')
    // 关键：传进来的 assistants 只含**当前 store** 的清单（含新分支），不含任何旧帧清单
    const branch = topic('branch', { parentTopicId: 'root', branchKind: 'regenerate' })
    const assistants = [assistant('a1', [root, branch])]

    expect(resolveTopicViewMemory(branch, assistants)).toEqual({
      assistantId: 'a1',
      root,
      branchId: 'branch',
      unchanged: false
    })
  })

  it('停在根话题上 → branchId 为 undefined（清空记忆）', () => {
    const root = topic('root', { lastViewedBranchId: 'branch' })
    const assistants = [assistant('a1', [root, topic('branch', { parentTopicId: 'root' })])]

    const memory = resolveTopicViewMemory(root, assistants)
    expect(memory?.branchId).toBeUndefined()
    expect(memory?.unchanged).toBe(false)
  })

  it('记忆与现状一致 → unchanged（调用方跳过派发）', () => {
    const root = topic('root', { lastViewedBranchId: 'branch' })
    const branch = topic('branch', { parentTopicId: 'root' })
    const assistants = [assistant('a1', [root, branch])]

    expect(resolveTopicViewMemory(branch, assistants)?.unchanged).toBe(true)
  })

  it('根行由别的助手持有 → 派发目标改指持有者（否则 updateTopic 静默 no-op）', () => {
    const root = topic('root', { assistantId: 'a2' })
    const branch = topic('branch', { assistantId: 'a2', parentTopicId: 'root' })
    const assistants = [assistant('a1', []), assistant('a2', [root, branch])]

    const memory = resolveTopicViewMemory(branch, assistants, 'a1')
    expect(memory?.assistantId).toBe('a2')
    expect(memory?.root.id).toBe('root')
  })

  it('行不在任何助手清单里（尚未物化）→ 用回退助手 id，根取 viewed 自身', () => {
    const branch = topic('orphan', { parentTopicId: 'missing' })

    const memory = resolveTopicViewMemory(branch, [assistant('a1', [])], 'a1')
    expect(memory?.assistantId).toBe('a1')
    expect(memory?.root.id).toBe('orphan')
    expect(memory?.branchId).toBeUndefined()
  })

  it('无助手、无回退 → 无法落点（调用方直接不写）', () => {
    expect(resolveTopicViewMemory(topic('x'), [])).toBeUndefined()
  })

  it('真机场景回归：首轮报错的话题连生两个分支 → 记忆落最新分支，重进话题召回它', () => {
    // 复刻部署实例 2026-09-23 的真实形态（根 aa378583 首轮 403、其后两个 regenerate 分支，
    // 根行此前 lastViewedBranchId 始终为空 ⇒ 重进话题落回报错那一轮）。
    const root = topic('root', { name: '默认话题' })
    const first = topic('branch-1', { parentTopicId: 'root', branchKind: 'regenerate', name: '1' })
    const second = topic('branch-2', { parentTopicId: 'root', branchKind: 'regenerate', name: '1' })
    const owner = assistant('default', [root, first, second])

    // 1) 记忆能写进去（此前这里是 undefined，整条记忆丢失）
    const memory = resolveTopicViewMemory(second, [owner])
    expect(memory).toMatchObject({ assistantId: 'default', root, branchId: 'branch-2' })

    // 2) 写完之后，侧栏点根话题能召回该分支（而不是回落到报错的根）
    const rootWithMemory = { ...root, lastViewedBranchId: memory?.branchId }
    expect(recallLastViewedBranch(rootWithMemory, owner.topics ?? []).id).toBe('branch-2')

    // 3) 记忆缺失时仍然会回落（自然容错，不改变既有语义）
    expect(recallLastViewedBranch(root, owner.topics ?? []).id).toBe('root')
  })
})
