import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'

const logger = loggerService.withContext('ExaProvider')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 ExaProvider.ts + @agentic/exa 7.3.3）：
 * - @agentic/exa 的 ExaClient → 等价裸 fetch：POST '{apiHost}/search'，header
 *   'x-api-key: <apiKey>'（agentic 客户端即此 header），body 照上游调用参数
 *   {query, numResults: max(1, maxResults), contents: {text: true}}；响应取
 *   autopromptString 与 results[].{title,url,text}。
 * - httpOptions.signal 透传（agentic/ky 无外部 abort，规则 f 要求透传）。
 */
interface ExaSearchResponse {
  autopromptString?: string
  results: Array<{
    title?: string
    url?: string
    text?: string
    publishedDate?: string
    author?: string
  }>
}

export default class ExaProvider extends BaseWebSearchProvider {
  constructor(provider: KernelWebSearchProviderConfig) {
    super(provider)
    if (!this.apiKey) {
      throw new Error('API key is required for Exa provider')
    }
    if (!this.apiHost) {
      throw new Error('API host is required for Exa provider')
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
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({
          query,
          numResults: Math.max(1, websearch.maxResults),
          contents: {
            text: true
          }
        }),
        signal: httpOptions?.signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Exa search failed: ${response.status} ${errorText}`)
      }

      const result: ExaSearchResponse = await response.json()

      return {
        query: result.autopromptString,
        results: result.results.slice(0, websearch.maxResults).map((item) => {
          return {
            title: item.title || 'No title',
            content: item.text || '',
            url: item.url || ''
          }
        })
      }
    } catch (error) {
      logger.error('Exa search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}
