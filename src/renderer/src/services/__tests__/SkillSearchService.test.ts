/**
 * 二轮审查 r2-07：`searchSkills` 扇出三个 registry，旧实现给每个源挂 `.catch(() => [])`
 * ——失败被替换成「成功但空」，与「该源确实没有命中」不可区分，`useSkills` 的 `setError`
 * 永不置位（三个源全断网时界面显示「无结果」，CLAUDE.md §9）。
 * 另外旧注释「keep first occurrence = fastest source」是错的（`Promise.allSettled` 等最慢的源，
 * 顺序只由数组决定），按裸 `name` 去重还会吞掉不同 registry 的同名 skill。
 *
 * 行为级断言：
 *   ① 失败按源结构化返回 `failed`；HTTP 非 2xx 也算源失败；
 *   ② 成功但零命中的源**不**进 `failed`（与失败可分）；
 *   ③ 三个源全失败：results 为空但 failed 三个都在 —— 调用方能据此报错而不是渲染空态；
 *   ④ 同名不同 registry 的两条都保留（去重键 = registry + slug）；
 *   ⑤ 同一 registry 内的同 slug 重复仍去重。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

import { searchSkills } from '../SkillSearchService'

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })

const skillsShPayload = (skills: unknown[]) => ({ query: 'q', skills, count: skills.length })
const claudePluginsPayload = (skills: unknown[]) => ({ skills })
const clawhubPayload = (results: unknown[]) => ({ results })

const skillsShItem = (id: string, name: string) => ({ id, skillId: id.split('/')[2], name, installs: 5, source: 'o/r' })
const claudeItem = (id: string, name: string) => ({ id, name, namespace: 'ns' })
const clawhubItem = (slug: string, displayName: string) => ({
  score: 1,
  slug,
  displayName,
  summary: 's',
  version: null,
  updatedAt: 1
})

describe('SkillSearchService 三源检索失败语义（r2-07）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
  })

  it('失败源进 failed，成功但零命中的源不进', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://skills.sh')) return ok(skillsShPayload([skillsShItem('o/r/one', 'One')]))
      if (url.startsWith('https://claude-plugins.dev')) return ok(claudePluginsPayload([])) // 成功但零命中
      return { ok: false, status: 503, json: async () => ({}) } // clawhub 挂了
    })

    const outcome = await searchSkills('q')

    expect(outcome.results.map((r) => r.slug)).toEqual(['o/r/one'])
    expect(outcome.failed).toEqual(['clawhub.ai'])
  })

  it('三个源全失败：results 为空但 failed 三个都在（不再是「无结果」）', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    const outcome = await searchSkills('q')

    expect(outcome.results).toEqual([])
    expect(outcome.failed).toEqual(['skills.sh', 'claude-plugins.dev', 'clawhub.ai'])
  })

  it('同名不同 registry 的 skill 都保留（去重键 = registry + slug）', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://skills.sh')) return ok(skillsShPayload([skillsShItem('o/r/same', 'Same')]))
      if (url.startsWith('https://claude-plugins.dev')) return ok(claudePluginsPayload([claudeItem('cp-same', 'Same')]))
      return ok(clawhubPayload([clawhubItem('claw-same', 'Same')]))
    })

    const outcome = await searchSkills('q')

    expect(outcome.failed).toEqual([])
    expect(outcome.results.map((r) => r.sourceRegistry).sort()).toEqual([
      'claude-plugins.dev',
      'clawhub.ai',
      'skills.sh'
    ])
    expect(outcome.results).toHaveLength(3)
  })

  it('同一 registry 内的同 slug 重复仍去重', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://skills.sh')) {
        return ok(skillsShPayload([skillsShItem('o/r/dup', 'Dup'), skillsShItem('o/r/dup', 'Dup')]))
      }
      return ok({ skills: [] })
    })

    const outcome = await searchSkills('q')

    expect(outcome.results).toHaveLength(1)
  })

  it('空查询不发请求，返回空结果 + 空失败清单', async () => {
    const outcome = await searchSkills('   ')

    expect(outcome).toEqual({ results: [], failed: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
