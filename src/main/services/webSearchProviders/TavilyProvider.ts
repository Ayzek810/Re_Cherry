import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'

const logger = loggerService.withContext('TavilyProvider')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 TavilyProvider.ts + @agentic/tavily 7.3.3）：
 * - @agentic/tavily 的 TavilyClient → 等价裸 fetch：POST '{apiHost}/search'，body 照
 *   agentic 客户端的 json 形态 {query, max_results, api_key}（api_key 在 body，非请求头），
 *   Content-Type JSON；响应取 query 与 results[].{title,url,content}。
 * - httpOptions.signal 透传（agentic/ky 无外部 abort，规则 f 要求透传）。
 */
interface TavilySearchResponse {
  query: string
  results: Array<{
    title?: string
    url?: string
    content?: string
  }>
}

export default class TavilyProvider extends BaseWebSearchProvider {
  constructor(provider: KernelWebSearchProviderConfig) {
    super(provider)
    if (!this.apiKey) {
      throw new Error('API key is required for Tavily provider')
    }
    if (!this.apiHost) {
      throw new Error('API host is required for Tavily provider')
    }
  }

  public async search(
    query: string,
    websearch: WebSearchRuntimeState,
    httpOptions?: WebSearchHttpOptions
  ): Promise<WebSearchProviderResponse> {
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty')
      }

      const response = await fetch(`${this.apiHost}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          max_results: Math.max(1, websearch.maxResults),
          api_key: this.apiKey
        }),
        signal: httpOptions?.signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Tavily search failed: ${response.status} ${errorText}`)
      }

      const result: TavilySearchResponse = await response.json()
      return {
        query: result.query,
        results: result.results.slice(0, websearch.maxResults).map((item) => {
          return {
            title: item.title || 'No title',
            content: item.content || '',
            url: item.url || ''
          }
        })
      }
    } catch (error) {
      logger.error('Tavily search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}
