import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'

const logger = loggerService.withContext('BochaProvider')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 BochaProvider.ts + utils/bocha.ts）：
 * - 上游本就是裸 fetch，请求构造原样保留：POST '{apiHost}/v1/web-search'，Bearer 头 +
 *   defaultHeaders，body {query, count, exclude, freshness, summary, page}；响应 code!==200
 *   明错，取 data.webPages.value 的 name/summary||snippet/url。
 * - zod schema 类型 → 本文件最小接口（主进程零新增依赖）。
 * - httpOptions.signal 透传（上游渲染层 fetch 未传，规则 f 要求 abort 一路透传）。
 */
interface BochaSearchParams {
  query: string
  count?: number
  exclude?: string
  freshness?: string
  summary?: boolean
  page?: number
}

interface BochaWebPage {
  name: string
  url: string
  snippet: string
  summary?: string
}

interface BochaSearchResponse {
  code: number
  msg?: string
  data: {
    queryContext: {
      originalQuery: string
    }
    webPages: {
      value: BochaWebPage[]
    }
  }
}

export default class BochaProvider extends BaseWebSearchProvider {
  constructor(provider: KernelWebSearchProviderConfig) {
    super(provider)
    if (!this.apiKey) {
      throw new Error('API key is required for Bocha provider')
    }
    if (!this.apiHost) {
      throw new Error('API host is required for Bocha provider')
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

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      }

      const params: BochaSearchParams = {
        query,
        count: websearch.maxResults,
        exclude: websearch.excludeDomains.join(','),
        freshness: websearch.searchWithTime ? 'oneDay' : 'noLimit',
        summary: true,
        page: 1
      }

      const response = await fetch(`${this.apiHost}/v1/web-search`, {
        method: 'POST',
        body: JSON.stringify(params),
        headers: {
          ...this.defaultHeaders(),
          ...headers
        },
        signal: httpOptions?.signal
      })

      if (!response.ok) {
        throw new Error(`Bocha search failed: ${response.status} ${response.statusText}`)
      }

      const resp: BochaSearchResponse = await response.json()
      if (resp.code !== 200) {
        throw new Error(`Bocha search failed: ${resp.msg}`)
      }
      return {
        query: resp.data.queryContext.originalQuery,
        results: resp.data.webPages.value.map((result) => ({
          title: result.name,
          // 优先使用 summary（更详细），如果没有则使用 snippet
          content: result.summary || result.snippet || '',
          url: result.url
        }))
      }
    } catch (error) {
      logger.error('Bocha search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}
