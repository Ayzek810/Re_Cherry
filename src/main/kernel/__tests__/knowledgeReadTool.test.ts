import { describe, expect, it, vi } from 'vitest'

// 切断 knowledgeReadTool → knowledgeService → SearchService → electron 的传递图
//（electron CJS 具名导入在 vitest 环境炸，registryPersistRace.test 同惯例）。
// 纯函数测试不需要服务行为；工具 execute 门由服务替身在集成节覆盖。
vi.mock('@main/services/knowledge/KnowledgeService', () => ({
  knowledgeService: {
    getTurnBases: vi.fn(() => undefined),
    readBaseDocument: vi.fn(async () => [])
  }
}))

import { concatChunks, grepDocument, slicePage } from '../knowledgeReadTool'

/**
 * knowledge_read 纯函数机测（v0.4.6）：chunk overlap 去重拼接、整读分页、文档内 grep。
 * 钉住的语义：
 *   - 硬切段落带 overlap 尾部 → 相邻同源 chunk 去重；段落合并 chunk（无 overlap）原样拼接
 *   - 跨文档（source 变化）不做去重（不同文档块间以空行衔接）
 *   - 分页：offset 越界回空页（不报错）；truncated + nextOffset 指引续读
 *   - grep：行号 1 起、totalMatches 恒全量、matches 截 maxMatches、大小写开关
 */
describe('concatChunks', () => {
  it('硬切段的 overlap 尾部被去重（后块前缀与前块后缀重叠）', () => {
    const base = 'A'.repeat(300) + 'B'.repeat(100)
    const chunks = [
      { content: base.slice(0, 300), source: 'doc1' },
      { content: base.slice(200, 400), source: 'doc1' }
    ]
    expect(concatChunks(chunks, 200)).toBe(base)
  })

  it('无重叠的段落合并 chunk 原样拼接（空行衔接）', () => {
    const chunks = [
      { content: '第一段', source: 'doc1' },
      { content: '第二段', source: 'doc1' }
    ]
    expect(concatChunks(chunks, 200)).toBe('第一段\n\n第二段')
  })

  it('跨文档（source 变化）不去重', () => {
    const chunks = [
      { content: 'tail text', source: 'doc1' },
      { content: 'tail text again', source: 'doc2' }
    ]
    expect(concatChunks(chunks, 200)).toBe('tail text\n\ntail text again')
  })

  it('maxOverlap=0 时同源 chunk 也不去重', () => {
    const chunks = [
      { content: 'abc', source: 'doc1' },
      { content: 'abcdef', source: 'doc1' }
    ]
    expect(concatChunks(chunks, 0)).toBe('abc\n\nabcdef')
  })

  it('重叠上限受 maxOverlap 约束（假性重叠超出窗口不去）', () => {
    // content2 的前 3 字符恰为 content1 的尾部，但 maxOverlap=2 → 只剥 2 字符
    const chunks = [
      { content: 'xxab', source: 'doc1' },
      { content: 'abcdef', source: 'doc1' }
    ]
    expect(concatChunks(chunks, 2)).toBe('xxab' + 'cdef')
  })
})

describe('slicePage', () => {
  const PAGE = 20000
  const text = 'x'.repeat(PAGE + 5000)

  it('首页与截断标记', () => {
    const { page, truncated, nextOffset } = slicePage(text, 0)
    expect(page).toHaveLength(PAGE)
    expect(truncated).toBe(true)
    expect(nextOffset).toBe(PAGE)
  })

  it('续读到末尾不再截断', () => {
    const { page, truncated, nextOffset } = slicePage(text, PAGE + 4000)
    expect(page).toHaveLength(1000)
    expect(truncated).toBe(false)
    expect(nextOffset).toBeUndefined()
  })

  it('offset 越界回空页（模型持过期 offset 时不报错）', () => {
    const { page, truncated, nextOffset } = slicePage(text, 999999)
    expect(page).toBe('')
    expect(truncated).toBe(false)
    expect(nextOffset).toBeUndefined()
  })

  it('非法 offset 回退首页', () => {
    const { page } = slicePage(text, Number.NaN)
    expect(page).toHaveLength(PAGE)
  })
})

describe('grepDocument', () => {
  const text = ['alpha one', 'beta two', 'alpha three', 'gamma'].join('\n')

  it('行号从 1 计、charStart 是该行在全文的偏移', () => {
    const { totalMatches, matches } = grepDocument(text, 'alpha', false, 50)
    expect(totalMatches).toBe(2)
    expect(matches[0]).toEqual({ line: 1, charStart: 0, snippet: 'alpha one' })
    expect(matches[1]?.line).toBe(3)
  })

  it('totalMatches 恒全量、matches 截 maxMatches', () => {
    const { totalMatches, matches } = grepDocument(text, 'alpha', false, 1)
    expect(totalMatches).toBe(2)
    expect(matches).toHaveLength(1)
  })

  it('ignoreCase 生效', () => {
    expect(grepDocument('ALPHA', 'alpha', true, 50).totalMatches).toBe(1)
    expect(grepDocument('ALPHA', 'alpha', false, 50).totalMatches).toBe(0)
  })

  it('无匹配返回空', () => {
    const { totalMatches, matches } = grepDocument(text, 'omega', false, 50)
    expect(totalMatches).toBe(0)
    expect(matches).toEqual([])
  })

  it('非法正则具名报错', () => {
    expect(() => grepDocument(text, '([', false, 50)).toThrow(/invalid pattern/)
  })
})
