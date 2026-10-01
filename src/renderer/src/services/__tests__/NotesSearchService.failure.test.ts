/**
 * 笔记全文检索把「读文件失败」与「该文件没有匹配」返回成同一个 `null`，
 * `searchAllFiles` 只按 `contentResult` 是否为 null 判断命中，于是读失败（权限/路径失效/编码）
 * 被静默渲染成「无结果」——调用方 `useFullTextSearch` 的 `setError` 永不执行。
 *
 * 行为级断言：
 *   ① 读失败的文件进 `failures`（带原因），零命中的文件不进；
 *   ② 命中仍进 `results`，一次检索里「有命中 + 有失败」可以同时成立（不是二选一）；
 *   ③ 全部文件读失败时 `results` 为空但 `failures` 非空 —— 调用方据此得到「N 个文件读取失败」，
 *      不再是被伪装成空结果；
 *   ④ `searchFileContent` 自身返回判别式（matched / no-match / error）；
 * ⑤ ：正则转义走 `utils/keywordSearch` 的唯一实现（`a.b` 不得匹配 `axb`）。
 */
import type { NotesTreeNode } from '@renderer/types/note'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readExternal } = vi.hoisted(() => ({ readExternal: vi.fn() }))

import { searchAllFiles, searchFileContent } from '../NotesSearchService'

function file(id: string, externalPath: string): NotesTreeNode {
  return {
    id,
    name: id,
    type: 'file',
    treePath: id,
    externalPath,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

describe('NotesSearchService 失败语义', () => {
  beforeEach(() => {
    readExternal.mockReset()
    ;(window as unknown as { api: unknown }).api = { file: { readExternal } }
  })

  it('读失败进 failures，零命中不进（两者不再同值）', async () => {
    readExternal.mockImplementation(async (path: string) => {
      if (path === '/notes/broken.md') throw new Error('EACCES: permission denied')
      if (path === '/notes/nomatch.md') return 'this file has no such token'
      return 'line with NEEDLE inside'
    })

    const outcome = await searchAllFiles(
      [file('a', '/notes/a.md'), file('broken', '/notes/broken.md'), file('nomatch', '/notes/nomatch.md')],
      'NEEDLE'
    )

    expect(outcome.results.map((r) => r.id)).toEqual(['a'])
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0].node.id).toBe('broken')
    expect(outcome.failures[0].error.message).toContain('EACCES')
  })

  it('全部读失败：results 为空但 failures 非空（不是「无结果」）', async () => {
    readExternal.mockRejectedValue(new Error('ENOENT: no such file'))

    const outcome = await searchAllFiles([file('a', '/notes/a.md'), file('b', '/notes/b.md')], 'NEEDLE')

    expect(outcome.results).toEqual([])
    expect(outcome.failures.map((f) => f.node.id)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(outcome.failures).toHaveLength(2)
  })

  it('文件名命中仍算结果，即使该文件内容读取失败', async () => {
    readExternal.mockRejectedValue(new Error('EIO'))

    const outcome = await searchAllFiles([file('NEEDLE-notes', '/notes/x.md')], 'NEEDLE')

    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].matchType).toBe('filename')
    expect(outcome.failures).toHaveLength(1)
  })

  it('searchFileContent 返回判别式：matched / no-match / error', async () => {
    readExternal.mockResolvedValueOnce('the NEEDLE is here')
    await expect(searchFileContent(file('a', '/notes/a.md'), 'NEEDLE')).resolves.toMatchObject({ kind: 'matched' })

    readExternal.mockResolvedValueOnce('nothing to see')
    await expect(searchFileContent(file('a', '/notes/a.md'), 'NEEDLE')).resolves.toEqual({ kind: 'no-match' })

    readExternal.mockRejectedValueOnce(new Error('EACCES'))
    const failed = await searchFileContent(file('a', '/notes/a.md'), 'NEEDLE')
    expect(failed.kind).toBe('error')
    expect(failed.kind === 'error' && failed.error.message).toBe('EACCES')
  })

  it('关键字按 utils/keywordSearch 的唯一实现转义（a.b 不匹配 axb）', async () => {
    readExternal.mockResolvedValue('axb and a.b both appear')

    const outcome = await searchAllFiles([file('a', '/notes/a.md')], 'a.b')

    expect(outcome.failures).toEqual([])
    expect(outcome.results).toHaveLength(1)
    // 只有字面量 a.b 命中：正则元字符被转义（若用了未转义的实现，axb 也会命中 → 2 条）
    expect(outcome.results[0].matches).toHaveLength(1)
    expect(outcome.results[0].matches?.[0].lineContent).toBe('axb and a.b both appear')
    expect(outcome.results[0].matches?.[0].context).toContain('a.b')
  })
})
