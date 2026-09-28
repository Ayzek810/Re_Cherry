/**
 * v0.4.3 引擎包装层契约：maxResults 终审截断（防个别提供商内部不截断响应——
 * Bocha/Querit 直接映射服务端返回）+ 黑名单两路并行过滤保持。
 */
import { describe, expect, it, vi } from 'vitest'

// 文件级断链（kernel 测试同惯例）：真实 SearchService/webFetch 会拉入 electron 原生链；
// 本文件只测包装层语义（终审截断 + 黑名单过滤），引擎内层 SDK 已被桩替换。
vi.mock('@main/services/SearchService', () => ({
  searchService: new Proxy({}, { get: () => vi.fn() }),
  SearchService: class {}
}))
vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: vi.fn(async () => ({ title: '', url: '', content: '' }))
}))

import WebSearchEngineProvider from '../index'
import type { WebSearchRuntimeState } from '../types'

const providerConfig = { id: 'tavily', name: 'Tavily', apiKey: 'k', apiHost: 'https://api.tavily.com' }

const runtime = (over: Partial<WebSearchRuntimeState> = {}): WebSearchRuntimeState =>
  ({ maxResults: 3, excludeDomains: [], blacklistPatterns: [], searchWithTime: false, ...over })

const makeEngine = async (sdkResults: Array<{ title: string; url: string; content: string }>, rt: WebSearchRuntimeState) => {
  const engine = new WebSearchEngineProvider(providerConfig, rt)
  ;(engine as unknown as { sdk: { search: ReturnType<typeof vi.fn> } }).sdk = {
    search: vi.fn(async () => ({ query: 'q', results: sdkResults }))
  }
  return engine
}

const result = (url: string) => ({ title: url, url, content: 'c' })

describe('maxResults 终审截断（v0.4.3）', () => {
  it('提供商返回超量 → 截到 runtime.maxResults（设置权威上限的兜底）', async () => {
    const results = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => result(`https://a.example/${i}`))
    const engine = await makeEngine(results, runtime({ maxResults: 3 }))
    const response = await engine.search('q')
    expect(response.results.length).toBe(3)
    expect(response.results.map((r) => r.url)).toEqual(['https://a.example/1', 'https://a.example/2', 'https://a.example/3'])
  })

  it('返回不足上限 → 原样通过（不回填）', async () => {
    const engine = await makeEngine([result('https://a.example/1')], runtime({ maxResults: 5 }))
    const response = await engine.search('q')
    expect(response.results.length).toBe(1)
  })

  it('黑名单过滤先于终审截断：过滤后余额照常截断', async () => {
    const results = [
      result('https://ads.example/1'),
      result('https://good.example/2'),
      result('https://good.example/3'),
      result('https://good.example/4'),
      result('https://good.example/5')
    ]
    const engine = await makeEngine(
      results,
      runtime({ maxResults: 3, excludeDomains: ['ads.example'] })
    )
    const response = await engine.search('q')
    expect(response.results.map((r) => r.url)).not.toContain('https://ads.example/1')
    expect(response.results.length).toBe(3)
  })
})
