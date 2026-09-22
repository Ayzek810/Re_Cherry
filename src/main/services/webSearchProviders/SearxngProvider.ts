import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'
import { fetchWebContent, noContent } from './webFetch'

const logger = loggerService.withContext('SearxngProvider')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 SearxngProvider.ts +
 * @agentic/searxng 7.3.3）：
 * - SearxngClient(@agentic/searxng) + ky → 等价裸 fetch：GET '{apiHost}/search?
 *   q=<query>&engines=<a,b>&language=auto&format=json'（与 agentic 客户端 searchParams
 *   同形：engines 数组逗号拼接、format 固定 json）；Basic 认证头按可选配置附加
 *   （btoa → Buffer base64）。
 * - 引擎发现（axios GET '{apiHost}/config'，5s 超时、仅接受 200）→ fetch +
 *   AbortSignal.timeout(5000)；enabled && categories 含 general+web 的过滤原样保留。
 * - fetchWebContent 走主进程 webFetch（直 fetch 优先，失败回退 SearchService 刮取；
 *   usingBrowser=true 直接刮取）；httpOptions（signal）透传。
 * - 构造期 initEngines().catch 仅记日志、搜索前懒初始化并吞错的时序保持上游。
 */
interface SearxngEngineConfig {
  enabled: boolean
  categories?: string[]
  name: string
}

interface SearxngSearchResultItem {
  url: string
  title?: string
  content?: string
}

interface SearxngSearchResponse {
  results?: SearxngSearchResultItem[]
  suggestions?: string[]
  query?: string
}

export default class SearxngProvider extends BaseWebSearchProvider {
  private engines: string[] = []
  private readonly basicAuthUsername?: string
  private readonly basicAuthPassword?: string
  private isInitialized = false

  constructor(provider: KernelWebSearchProviderConfig) {
    super(provider)
    if (!provider.apiHost) {
      throw new Error('API host is required for SearxNG provider')
    }

    this.basicAuthUsername = provider.basicAuthUsername
    this.basicAuthPassword = provider.basicAuthPassword ? provider.basicAuthPassword : ''

    this.initEngines().catch((err) => logger.error('Failed to initialize SearxNG engines:', err as Error))
  }

  /** ky 不直接支持 basic auth（上游经 ky.create headers / axios auth），fetch 用请求头表达。 */
  private authHeaders(): Record<string, string> | undefined {
    if (!this.basicAuthUsername) {
      return undefined
    }
    const token = Buffer.from(`${this.basicAuthUsername}:${this.basicAuthPassword}`).toString('base64')
    return { Authorization: `Basic ${token}` }
  }

  private joinUrl(path: string): string {
    // 上游 ky prefixUrl 拼接语义：去掉 apiHost 尾部斜杠后接 '/path'
    return `${(this.apiHost ?? '').replace(/\/+$/, '')}${path}`
  }

  private async initEngines(): Promise<void> {
    try {
      logger.info(`Initializing SearxNG with API host: ${this.apiHost}`)
      const response = await fetch(this.joinUrl('/config'), {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000)
      })

      // 上游 axios validateStatus 仅接受 200
      if (!response.ok) {
        throw new Error(`SearxNG config request failed: ${response.status}`)
      }

      const data = (await response.json()) as { engines?: SearxngEngineConfig[] }

      if (!data) {
        throw new Error('Empty response from SearxNG config endpoint')
      }

      if (!Array.isArray(data.engines)) {
        throw new Error('Invalid response format: "engines" property not found or not an array')
      }

      const allEngines = data.engines
      logger.info(`Found ${allEngines.length} total engines in SearxNG`)

      this.engines = allEngines
        .filter(
          (engine) =>
            engine.enabled &&
            Array.isArray(engine.categories) &&
            engine.categories.includes('general') &&
            engine.categories.includes('web')
        )
        .map((engine) => engine.name)

      if (this.engines.length === 0) {
        throw new Error('No enabled general web search engines found in SearxNG configuration')
      }

      this.isInitialized = true
      logger.info(`SearxNG initialized successfully with ${this.engines.length} engines: ${this.engines.join(', ')}`)
    } catch (err) {
      this.isInitialized = false

      logger.error('Failed to fetch SearxNG engine configuration:', err as Error)
      throw new Error(`Failed to initialize SearxNG: ${err}`)
    }
  }

  public async search(
    query: string,
    websearch: WebSearchRuntimeState,
    httpOptions?: WebSearchHttpOptions
  ): Promise<WebSearchProviderResponse> {
    try {
      if (!query) {
        throw new Error('Search query cannot be empty')
      }

      // Wait for initialization if it's the first search
      if (!this.isInitialized) {
        await this.initEngines().catch(() => {}) // Ignore errors
      }

      // agentic SearxngClient.search 同形 searchParams：q + engines(逗号拼接) + language + format=json
      const searchParams = new URLSearchParams({
        q: query,
        engines: this.engines.join(','),
        language: 'auto',
        format: 'json'
      })

      const response = await fetch(`${this.joinUrl('/search')}?${searchParams}`, {
        headers: this.authHeaders(),
        signal: httpOptions?.signal
      })

      if (!response.ok) {
        throw new Error(`SearxNG search failed: ${response.status} ${response.statusText}`)
      }

      const result: SearxngSearchResponse = await response.json()

      if (!result || !Array.isArray(result.results)) {
        throw new Error('Invalid search results from SearxNG')
      }

      const validItems = result.results
        .filter((item) => item.url.startsWith('http') || item.url.startsWith('https'))
        .slice(0, websearch.maxResults)

      // Fetch content for each URL concurrently
      const fetchPromises = validItems.map(async (item) => {
        return await fetchWebContent(item.url, 'markdown', this.provider.usingBrowser, httpOptions)
      })

      // Wait for all fetches to complete
      const results = await Promise.all(fetchPromises)

      return {
        query: query,
        results: results.filter((item) => item.content !== noContent)
      }
    } catch (error) {
      logger.error('Searxng search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}
