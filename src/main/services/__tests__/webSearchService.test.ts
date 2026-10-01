/**
 * 网络搜索设置契约测试（「设置控制项实质性反映在工具中」验收标准）：
 * - count 权威语义：设置 maxResults 是唯一权威上限——缺省即设置值，模型显式 count
 *   超出钳回、以下尊重（此前工具硬编码 1..12：设置 3 可被突破、设置 100 被 12 截断）。
 * - RAG 预抓全页：snippet 型（< 1000 字符分块窗口）结果先抓全页再进压缩相，
 *   documentCount/嵌入/重排对 API 型提供商实质生效（此前 RAG 恒为 N -> N 的 no-op）。
 * - check() 裸搜索：连通性检查不过压缩相（RAG 下不应触发全页抓取 + 嵌入）。
 * - cutoff / 失败降级 / abort 传播 / searchWithTime 前缀行为保持。
 *
 * mock 布局：vi.fn 一律 vi.hoisted（vi.mock 工厂在顶层 const 初始化前执行——
 * WebSearchService 的 import 面先于本文件其余语句求值）；noContent 工厂内联字面量。
 */
import type { KernelWebSearchConfig } from '@shared/config/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  compressWithRag: vi.fn(),
  fetchWebContent: vi.fn(),
  isAbortError: vi.fn((error: unknown) => error instanceof Error && error.name === 'AbortError'),
  // 引擎包装层每轮 search() 现场实例化——桩必须先于实例存在，故共享同一 vi.fn
  engineSearch: vi.fn(
    async (): Promise<{ query: string; results: Array<{ title: string; url: string; content: string }> }> => ({
      query: 'q',
      results: []
    })
  )
}))

vi.mock('../webSearchProviders/compression', () => ({ compressWithRag: m.compressWithRag }))
vi.mock('../webSearchProviders/webFetch', () => ({
  fetchWebContent: m.fetchWebContent,
  isAbortError: m.isAbortError,
  noContent: 'No content found'
}))

interface EngineInstance {
  provider: unknown
  runtime: { maxResults: number; searchWithTime?: boolean; language?: string; usingBrowser?: boolean }
}
const engineInstances = vi.hoisted(() => [] as EngineInstance[])

vi.mock('../webSearchProviders', () => ({
  default: class {
    provider: unknown
    runtime: { maxResults: number; searchWithTime?: boolean; language?: string; usingBrowser?: boolean }
    search = m.engineSearch
    constructor(provider: unknown, runtime: { maxResults: number; searchWithTime?: boolean }) {
      this.provider = provider
      this.runtime = runtime
      engineInstances.push(this as unknown as EngineInstance)
    }
  }
}))

import { webSearchService } from '../WebSearchService'

const NO_CONTENT = 'No content found'

const baseConfig = (over: Partial<KernelWebSearchConfig>): KernelWebSearchConfig =>
  ({
    providers: [{ id: 'tavily', name: 'Tavily', apiKey: 'k', apiHost: 'https://api.tavily.com' }],
    blacklist: [],
    excludeDomains: [],
    searchWithTime: false,
    maxResults: 3,
    ...over
  }) as KernelWebSearchConfig

const result = (url: string, content: string) => ({ title: `t of ${url}`, url, content })

const lastFedResults = (): Array<{ url: string; content: string }> => {
  const call = m.compressWithRag.mock.calls[m.compressWithRag.mock.calls.length - 1]
  return call?.[1] as Array<{ url: string; content: string }>
}

beforeEach(() => {
  engineInstances.length = 0
  m.engineSearch.mockReset()
  m.engineSearch.mockImplementation(async () => ({ query: 'q', results: [] }))
  m.compressWithRag.mockReset()
  m.compressWithRag.mockImplementation(
    async (_questions: unknown, results: Array<{ title: string; url: string; content: string }>) =>
      results.map((r) => ({ ...r, content: `[compressed] ${r.content.slice(0, 20)}` }))
  )
  m.fetchWebContent.mockReset()
  m.fetchWebContent.mockImplementation(async (url: string) => ({ title: url, url, content: NO_CONTENT }))
  m.isAbortError.mockClear()
  webSearchService.setConfig(baseConfig({}))
})

describe('count 权威语义（设置「搜索结果个数」是唯一权威上限）', () => {
  it('缺省 count = 设置 maxResults', async () => {
    await webSearchService.search('tavily', 'q')
    expect(engineInstances[0].runtime.maxResults).toBe(3)
  })

  it('模型显式 count 超出设置值 → 钳回设置值（此前硬编码 12 截断设置 100 的场景）', async () => {
    webSearchService.setConfig(baseConfig({ maxResults: 100 }))
    await webSearchService.search('tavily', 'q', { count: 50 })
    expect(engineInstances[0].runtime.maxResults).toBe(50)
    await webSearchService.search('tavily', 'q', { count: 120 })
    expect(engineInstances[1].runtime.maxResults).toBe(100)
  })

  it('模型显式 count 低于设置值 → 尊重收窄；设置 3 时模型传 10 不再突破上限', async () => {
    await webSearchService.search('tavily', 'q', { count: 2 })
    expect(engineInstances[0].runtime.maxResults).toBe(2)
    await webSearchService.search('tavily', 'q', { count: 10 })
    expect(engineInstances[1].runtime.maxResults).toBe(3)
  })

  it('getConfiguredMaxResults 反映设置（钳最小 1）', () => {
    webSearchService.setConfig(baseConfig({ maxResults: 42 }))
    expect(webSearchService.getConfiguredMaxResults()).toBe(42)
    webSearchService.setConfig(baseConfig({ maxResults: 0 }))
    expect(webSearchService.getConfiguredMaxResults()).toBe(1)
  })
})

describe('RAG 预抓全页（snippet 型提供商的 RAG 控制项实质生效）', () => {
  const ragConfig = baseConfig({
    compression: {
      method: 'rag',
      documentCount: 2,
      embedding: { providerId: 'p1', modelId: 'm1' }
    }
  })

  it('贫瘠正文（< 1000 字符）先抓全页再进压缩相；长正文原样通过', async () => {
    const longContent = 'x'.repeat(2000)
    webSearchService.setConfig(ragConfig)
    m.engineSearch.mockResolvedValue({
      query: 'q',
      results: [result('https://a.example/1', 'short snippet'), result('https://b.example/2', longContent)]
    })
    m.fetchWebContent.mockResolvedValue({ title: 'full', url: 'https://a.example/1', content: 'F'.repeat(5000) })

    const response = await webSearchService.search('tavily', 'q')

    expect(m.fetchWebContent).toHaveBeenCalledTimes(1)
    expect(m.fetchWebContent).toHaveBeenCalledWith('https://a.example/1', 'markdown', false, {
      signal: undefined
    })
    expect(m.compressWithRag).toHaveBeenCalledTimes(1)
    const fedResults = lastFedResults()
    expect(fedResults[0].content).toBe('F'.repeat(5000))
    expect(fedResults[1].content).toBe(longContent)
    expect(response.compression).toEqual({ method: 'rag', before: 2, after: 2 })
  })

  it('抓取失败（noContent/空正文）保留 snippet，不拖垮整轮压缩', async () => {
    webSearchService.setConfig(ragConfig)
    m.engineSearch.mockResolvedValue({ query: 'q', results: [result('https://a.example/1', 'short snippet')] })
    m.fetchWebContent.mockResolvedValue({ title: 'x', url: 'https://a.example/1', content: NO_CONTENT })

    await webSearchService.search('tavily', 'q')

    expect(lastFedResults()[0].content).toBe('short snippet')
  })

  it('usingBrowser 语义透传全页抓取', async () => {
    webSearchService.setConfig(
      baseConfig({
        compression: { method: 'rag', embedding: { providerId: 'p1', modelId: 'm1' } },
        providers: [{ id: 'local-bing', name: 'Bing', url: 'https://bing/search?q=%s', usingBrowser: true }]
      })
    )
    m.engineSearch.mockResolvedValue({ query: 'q', results: [result('https://a.example/1', 'short')] })
    m.fetchWebContent.mockResolvedValue({ title: 'f', url: 'https://a.example/1', content: 'F'.repeat(3000) })

    await webSearchService.search('local-bing', 'q')

    expect(m.fetchWebContent).toHaveBeenCalledWith('https://a.example/1', 'markdown', true, { signal: undefined })
  })

  it('无嵌入模型 → 压缩明错上浮，不触发抓取', async () => {
    webSearchService.setConfig(baseConfig({ compression: { method: 'rag' } }))
    m.engineSearch.mockResolvedValue({ query: 'q', results: [result('https://a.example/1', 'short')] })

    const response = await webSearchService.search('tavily', 'q')

    expect(m.fetchWebContent).not.toHaveBeenCalled()
    expect(m.compressWithRag).not.toHaveBeenCalled()
    expect(response.compression?.error).toContain('embedding model')
  })

  it('压缩失败 → 失败原因如实上浮（结果保留原始 snippet）；abort 原样上抛', async () => {
    webSearchService.setConfig(ragConfig)
    m.engineSearch.mockResolvedValue({ query: 'q', results: [result('https://a.example/1', 'short')] })
    m.fetchWebContent.mockResolvedValue({ title: 'f', url: 'https://a.example/1', content: 'F'.repeat(3000) })
    m.compressWithRag.mockRejectedValueOnce(new Error('embed down'))
    const failed = await webSearchService.search('tavily', 'q')
    expect(failed.compression?.error).toBe('embed down')
    expect(failed.results[0].content).toBe('short')

    m.compressWithRag.mockRejectedValueOnce(Object.assign(new Error('stopped'), { name: 'AbortError' }))
    await expect(webSearchService.search('tavily', 'q')).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('check() 裸搜索（连通性检查不过压缩相）', () => {
  it('RAG 配置下 check 不抓全页、不压缩，返回布尔', async () => {
    webSearchService.setConfig(
      baseConfig({ compression: { method: 'rag', embedding: { providerId: 'p1', modelId: 'm1' } } })
    )
    m.engineSearch.mockResolvedValue({ query: 'test query', results: [result('https://a.example/1', 'short')] })

    const ok = await webSearchService.check('tavily')

    expect(ok).toBe(true)
    expect(m.fetchWebContent).not.toHaveBeenCalled()
    expect(m.compressWithRag).not.toHaveBeenCalled()
    expect(m.engineSearch).toHaveBeenCalledWith('test query')
  })

  it('引擎抛错 → false（诚实失败）', async () => {
    m.engineSearch.mockRejectedValue(new Error('down'))
    expect(await webSearchService.check('tavily')).toBe(false)
  })

  it('未配置提供商 → false', async () => {
    expect(await webSearchService.check('nope')).toBe(false)
  })
})

describe('cutoff 截断与 searchWithTime（行为保持）', () => {
  it('cutoff char：per-result 均分预算截断', async () => {
    webSearchService.setConfig(baseConfig({ compression: { method: 'cutoff', cutoffLimit: 100, cutoffUnit: 'char' } }))
    m.engineSearch.mockResolvedValue({
      query: 'q',
      results: [result('https://a.example/1', 'a'.repeat(400)), result('https://b.example/2', 'b'.repeat(30))]
    })

    const response = await webSearchService.search('tavily', 'q')

    expect(response.compression).toEqual({ method: 'cutoff', before: 2, after: 2 })
    expect(response.results[0].content.length).toBe(53)
    expect(response.results[0].content.endsWith('...')).toBe(true)
    expect(response.results[1].content).toBe('b'.repeat(30))
  })

  it('searchWithTime：查询加日期前缀', async () => {
    webSearchService.setConfig(baseConfig({ searchWithTime: true }))
    await webSearchService.search('tavily', 'q')
    const firstCall = m.engineSearch.mock.calls[0] as unknown[] | undefined
    const query = firstCall?.[0] as string
    expect(query).toMatch(/^today is \d{4}-\d{2}-\d{2} \r\n q$/)
  })
})
