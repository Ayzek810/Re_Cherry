import { describe, expect, it, vi } from 'vitest'

/**
 * **数据源全失败不得说成"没找到"**。
 *
 * 本文件是四处工具的**行为契约钉子**：
 *   - `knowledge_search`：全部库失败 → 抛错；有库成功但 0 命中 → 中性一句；部分失败 → 明说结果不完整。
 *   - `web_search`：引擎抛错 → 抛错（不返回 "No web results found"）；真的 0 条 → 中性一句。
 *   - `web_fetch`：全部页失败 → 抛错；**取消** → 明说取消（不是"空请求"）。
 *
 * 工具文本是注入模型的内容本身，故断言落在 `text` 与 reject 原因上，不依赖 UI。
 */

// knowledgeSearchTool → knowledgeService → SearchService → electron 的传递图切断
//（与 knowledgeReadTool.test 同惯例）。
const searchMock = vi.hoisted(() => vi.fn())
vi.mock('@main/services/knowledge/KnowledgeService', () => ({
  knowledgeService: {
    getTurnBases: vi.fn(() => [
      { id: 'base-1', chunkSize: 800, chunkOverlap: 100, documentCount: 1, embedding: {}, threshold: 0 },
      { id: 'base-2', chunkSize: 800, chunkOverlap: 100, documentCount: 1, embedding: {}, threshold: 0 }
    ]),
    search: searchMock
  }
}))

const engineSearchMock = vi.hoisted(() => vi.fn())
const turnProviderMock = vi.hoisted(() => vi.fn(() => 'provider-1'))
vi.mock('@main/services/WebSearchService', () => ({
  webSearchService: {
    getTurnProvider: turnProviderMock,
    search: engineSearchMock,
    bumpTurnResultOffset: vi.fn(() => 0),
    isCompressionActive: vi.fn(() => false)
  }
}))

const fetchPageMock = vi.hoisted(() => vi.fn())
vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: fetchPageMock,
  isAbortError: (error: unknown): boolean => error instanceof Error && error.name === 'AbortError',
  noContent: 'No content found'
}))

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 走真 `defineTool` 挂载，取回注册定义（与 webFetchTool.test 同型）。 */
async function buildTool(modulePath: string): Promise<RegisteredTool> {
  const { Context } = await import('@deepseek-ai/cordis')
  const module = (await import(modulePath)) as { apply: (ctx: unknown) => void }
  const ctx = new Context()
  const holder: { current?: RegisteredTool } = {}
  ;(ctx as unknown as { tools: { register: (definition: never) => void } }).tools = {
    register: (definition: never) => {
      holder.current = definition as unknown as RegisteredTool
    }
  }
  module.apply(ctx)
  if (holder.current === undefined) throw new Error(`${modulePath} did not register a tool`)
  return holder.current
}

function makeExec(topicId = 'topic-1', signal?: AbortSignal): unknown {
  return {
    callId: 'c1',
    rootCallId: 'c1',
    name: 'tool',
    arguments: {},
    token: Symbol('t'),
    agent: { session: { id: topicId, events: [] } },
    signal: signal ?? new AbortController().signal
  }
}

describe('knowledge_search：数据源全失败 ≠ 空结果', () => {
  it('全部库失败 → 直接抛错，错误里带每个库的失败原因', async () => {
    searchMock.mockReset()
    searchMock
      .mockRejectedValueOnce(new Error('embedding service unavailable'))
      .mockRejectedValueOnce(new Error('base not found'))
    const tool = await buildTool('../knowledgeSearchTool')

    await expect(tool.execute({ query: 'anything' }, makeExec())).rejects.toThrow(
      /every knowledge base failed \(2\): base base-1: embedding service unavailable; base base-2: base not found/
    )
  })

  it('库全部成功但 0 命中 → 中性一句，且不出现任何失败措辞', async () => {
    searchMock.mockReset()
    searchMock.mockResolvedValue([])
    const tool = await buildTool('../knowledgeSearchTool')

    const result = (await tool.execute({ query: 'anything' }, makeExec())) as { results: number; text: string }

    expect(result.results).toBe(0)
    expect(result.text).toContain('returned no matching fragments')
    expect(result.text).not.toContain('failed')
    expect(result.text).not.toContain('Warning')
  })

  it('部分库失败 → 结果照给，但显式声明"结果不完整"', async () => {
    searchMock.mockReset()
    searchMock.mockRejectedValueOnce(new Error('embedding service unavailable')).mockResolvedValueOnce([
      {
        score: 0.9,
        source: 'doc.md',
        uniqueId: 'u1',
        pageContent: 'relevant fragment',
        metadata: { source: 'doc.md' }
      }
    ])
    const tool = await buildTool('../knowledgeSearchTool')

    const result = (await tool.execute({ query: 'anything' }, makeExec())) as { results: number; text: string }

    expect(result.results).toBe(1)
    expect(result.text).toContain('results are incomplete. 1 of 2 knowledge base(s) failed')
    expect(result.text).toContain('embedding service unavailable')
  })
})

describe('web_search：引擎失败 ≠ 没有结果', () => {
  it('引擎抛错 → 工具以失败拒绝，不返回 "No web results found"', async () => {
    engineSearchMock.mockReset()
    engineSearchMock.mockRejectedValueOnce(new Error('engine not ready'))
    const tool = await buildTool('../webSearchTool')

    await expect(tool.execute({ query: 'news' }, makeExec())).rejects.toThrow(
      /search failed via provider "provider-1": engine not ready/
    )
  })

  it('引擎成功但 0 条 → 中性一句（这条"没找到"是真的）', async () => {
    engineSearchMock.mockReset()
    engineSearchMock.mockResolvedValueOnce({ results: [] })
    const tool = await buildTool('../webSearchTool')

    const result = (await tool.execute({ query: 'news' }, makeExec())) as { results: number; text: string }

    expect(result.results).toBe(0)
    expect(result.text).toBe('No web results found for "news". Try different keywords.')
  })
})

describe('web_fetch：全部页失败 / 取消', () => {
  it('每一页都失败 → 抛错，而不是回一份"已取回"的列表', async () => {
    fetchPageMock.mockReset()
    fetchPageMock.mockRejectedValue(new Error('network down'))
    const tool = await buildTool('../webFetchTool')

    await expect(
      tool.execute({ urls: ['https://a.example.com/1', 'https://b.example.com/2'] }, makeExec())
    ).rejects.toThrow(/every page failed \(2\): https:\/\/a\.example\.com\/1: network down/)
  })

  it('部分页失败 → 失败页以具名条目进列表（不连坐整批）', async () => {
    fetchPageMock.mockReset()
    fetchPageMock
      .mockResolvedValueOnce({ title: 'Good', url: 'https://good.example.com/', content: 'body' })
      .mockRejectedValueOnce(new Error('network down'))
    const tool = await buildTool('../webFetchTool')

    const result = (await tool.execute(
      { urls: ['https://good.example.com/', 'https://bad.example.com/'] },
      makeExec()
    )) as { results: number; text: string }

    expect(result.results).toBe(2)
    expect(result.text).toContain('Fetch failed: network down')
    expect(result.text).toContain('Good')
  })

  it('执行前已取消 → 如实说取消，不说"空请求"', async () => {
    fetchPageMock.mockReset()
    const controller = new AbortController()
    controller.abort()
    const tool = await buildTool('../webFetchTool')

    const result = (await tool.execute(
      { urls: ['https://a.example.com/'] },
      makeExec('topic-1', controller.signal)
    )) as { results: number; text: string }

    expect(result.results).toBe(0)
    expect(result.text).toContain('Fetch cancelled before any page was retrieved')
    expect(result.text).not.toContain('empty request')
    expect(fetchPageMock).not.toHaveBeenCalled()
  })
})
