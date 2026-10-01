import { type Topic, TopicType } from '@renderer/types'
import { collectSubtreeIds, familyRowSignature, rootTopicOf } from '@renderer/utils/topicBranch'
import { describe, expect, it } from 'vitest'

/**
 * r2-71 对拍：血缘闭包的**索引版**必须与改动前的逐轮全表扫描版**同值**。
 *
 * 改动只允许是性能改动（O(n·血缘深度) → O(n)），所以这里把改动前的两份实现原样保留为
 * 参考基准，在确定性伪随机森林上逐例比对：单值签名、删除闭包、根行对象。
 * 语料含：同 id 多份持有（跨助手污染副本）、隔层链、共父兄弟、父行缺失、父行为空串、
 * 自指行、互为父子的环、以及不在清单里的根 id。
 *
 * 不生成空串 **id**：真实的 `topic.id` 从不为空，空串只可能出现在 `parentTopicId` 上。
 * 两份实现对"空串父 id"的处理本来就不同（旧签名按假值跳过、旧删除闭包不跳过），
 * 而 `ids` 里永远不含空串 id，故该差异不可达——下面的对拍同时覆盖这一点。
 */

const TS = '2026-09-01T00:00:00.000Z'

// ---------------------------------------------------------------------------
// 参考基准：改动前的实现（逐字抄自 r2-71 之前的 `utils/topicBranch.ts` 与 `store/assistants.ts`）
// ---------------------------------------------------------------------------

function legacyRootTopicOf(topic: Topic, allTopics: Topic[]): Topic {
  let current = topic
  const visited = new Set<string>()
  while (current.parentTopicId !== undefined && current.parentTopicId.length > 0 && !visited.has(current.id)) {
    visited.add(current.id)
    const parent = allTopics.find((candidate) => candidate.id === current.parentTopicId)
    if (parent === undefined) break
    current = parent
  }
  return current
}

function legacyFamilyRowSignature(allTopics: Topic[], topicId: string): string {
  const self = allTopics.find((row) => row.id === topicId)
  if (!self) return ''
  const root = legacyRootTopicOf(self, allTopics)
  const ids = new Set<string>([root.id])
  // 迭代收敛：行的父在本集合 → 行属于家族（血缘链可能隔多层）
  let grew = true
  while (grew) {
    grew = false
    for (const row of allTopics) {
      if (ids.has(row.id) || !row.parentTopicId) continue
      if (ids.has(row.parentTopicId) && !ids.has(row.id)) {
        ids.add(row.id)
        grew = true
      }
    }
  }
  return allTopics
    .filter((row) => ids.has(row.id))
    .map((row) => row.id + ':' + row.updatedAt + ':' + (row.branchKind ?? ''))
    .sort()
    .join('|')
}

function legacyCollectSubtreeIds(topics: Topic[], roots: string[]): Set<string> {
  const ids = new Set<string>(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const topic of topics) {
      if (topic.parentTopicId !== undefined && ids.has(topic.parentTopicId) && !ids.has(topic.id)) {
        ids.add(topic.id)
        changed = true
      }
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// 确定性伪随机语料（xorshift32）：失败可复现，不读时钟、不用 Math.random。
// ---------------------------------------------------------------------------

function makeRandom(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

function randomForest(random: () => number): Topic[] {
  const count = Math.floor(random() * 10)
  const idPool: string[] = []
  for (let index = 0; index < count; index += 1) {
    // 池子小于行数 ⇒ 同 id 多份持有，与跨助手污染副本同形
    idPool.push('t' + Math.floor(random() * Math.max(1, count - 1)))
  }
  return idPool.map((id, index) => {
    const roll = random()
    const parentTopicId =
      roll < 0.15
        ? undefined // 根行
        : roll < 0.25
          ? 'missing-' + index // 父行缺失
          : roll < 0.3
            ? '' // 空串父 id
            : idPool[Math.floor(random() * idPool.length)] // 可能是自己（自指）或成环
    const base = {
      id,
      type: TopicType.Chat,
      assistantId: 'a1',
      name: id,
      createdAt: TS,
      updatedAt: TS + '#' + index,
      messages: []
    }
    return (parentTopicId === undefined ? base : { ...base, parentTopicId }) as Topic
  })
}

describe('r2-71 血缘闭包：索引版与旧的逐轮扫描版逐字同值', () => {
  it('400 个随机森林 × 全部探针：签名 / 删除闭包 / 根行对象全部一致', () => {
    const random = makeRandom(0x71_7157)
    let comparisons = 0
    for (let round = 0; round < 400; round += 1) {
      const rows = randomForest(random)
      const probes = [...new Set(rows.map((row) => row.id)), 'not-in-list', '']
      for (const probe of probes) {
        expect(familyRowSignature(rows, probe)).toBe(legacyFamilyRowSignature(rows, probe))
        expect([...collectSubtreeIds(rows, [probe])].sort()).toEqual([...legacyCollectSubtreeIds(rows, [probe])].sort())
        const self = rows.find((row) => row.id === probe)
        if (self !== undefined) {
          expect(rootTopicOf(self, rows).id).toBe(legacyRootTopicOf(self, rows).id)
        }
        comparisons += 1
      }
      // 多根一次调用（removeTopic/pruneTopics 的批量形态）
      const multiRoots = probes.slice(0, 2)
      expect([...collectSubtreeIds(rows, multiRoots)].sort()).toEqual(
        [...legacyCollectSubtreeIds(rows, multiRoots)].sort()
      )
    }
    // 语料规模自检：探针数不为零，否则上面的期望等于没跑
    expect(comparisons).toBeGreaterThan(400)
  })

  it('深链（血缘深度 = 行数）上仍与旧实现同值——旧实现最坏 O(n²) 的形态', () => {
    const depth = 60
    const chain: Topic[] = [
      {
        id: 'c0',
        type: TopicType.Chat,
        assistantId: 'a1',
        name: 'c0',
        createdAt: TS,
        updatedAt: TS,
        messages: []
      } as Topic
    ]
    for (let index = 1; index < depth; index += 1) {
      chain.push({
        id: 'c' + index,
        type: TopicType.Chat,
        assistantId: 'a1',
        name: 'c' + index,
        createdAt: TS,
        updatedAt: TS,
        messages: [],
        parentTopicId: 'c' + (index - 1)
      } as Topic)
    }
    expect(familyRowSignature(chain, 'c' + (depth - 1))).toBe(legacyFamilyRowSignature(chain, 'c' + (depth - 1)))
    expect(familyRowSignature(chain, 'c0')).toBe(legacyFamilyRowSignature(chain, 'c0'))
    expect([...collectSubtreeIds(chain, ['c0'])]).toHaveLength(depth)
    expect([...collectSubtreeIds(chain, ['c0'])].sort()).toEqual([...legacyCollectSubtreeIds(chain, ['c0'])].sort())
  })
})
