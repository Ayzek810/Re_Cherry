import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'
import { parseSearchResults, type SearchEngineId } from '@shared/utils/searchResultParser'

import { searchService } from '../SearchService'
import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'
import { fetchSerpPage, fetchWebContent, isAbortError, noContent } from './webFetch'

const logger = loggerService.withContext('LocalSearchProvider')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 LocalSearchProvider.ts）：
 * - 渲染层 searchService 桥的 openUrlInSearchWindow → webFetch.fetchSerpPage
 *   （v0.3.2 真机事故改为三级回退链：隐藏窗口 → net.fetch → Node 直连；上游单级
 *   窗口路径在 Chromium 网络服务失效的机器上整体死路，详见 webFetch 注释）；
 *   closeSearchWindow 为 fork SearchService 补齐的方法（按 uid 泄漏窗口修复）。
 * - parseValidUrls 的 DOM 解析查询 → @shared/utils/searchResultParser（子类只声明
 *   engineId，选择器语义见共享解析器各引擎注释）。
 * - nanoid → crypto.randomUUID；language 取运行时注入（上游取 Redux settings.language）。
 * - fetchWebContent 走主进程 webFetch（net.fetch→Node 直连两级直抓，失败回退窗口
 *   刮取；usingBrowser 时直接刮取）；httpOptions（含 signal）透传。
 * - 查询清洗（split('\r\n')[1] 摘掉 searchWithTime 前缀行）与 lang: 语言过滤（google/bing）
 *   保持上游语义。
 */
export default abstract class LocalSearchProvider extends BaseWebSearchProvider {
  /** 共享解析器的引擎标识（google / bing / baidu）。 */
  protected abstract get engineId(): SearchEngineId

  constructor(provider: KernelWebSearchProviderConfig) {
    if (!provider || !provider.url) {
      throw new Error('Provider URL is required')
    }
    super(provider)
  }

  public async search(
    query: string,
    websearch: WebSearchRuntimeState,
    httpOptions?: WebSearchHttpOptions
  ): Promise<WebSearchProviderResponse> {
    const uid = `search-${crypto.randomUUID()}`
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty')
      }
      if (!this.provider.url) {
        throw new Error('Provider URL is required')
      }

      const cleanedQuery = query.split('\r\n')[1] ?? query
      const queryWithLanguage = websearch.language
        ? this.applyLanguageFilter(cleanedQuery, websearch.language)
        : cleanedQuery
      const url = this.provider.url.replace('%s', encodeURIComponent(queryWithLanguage))
      // 三级回退链（窗口 → net.fetch → Node 直连），外部 signal 中止向上传播。
      const content = await fetchSerpPage(url, httpOptions?.signal, this.engineId)

      // Parse the content to extract URLs and metadata
      const searchItems = this.parseValidUrls(content).slice(0, websearch.maxResults)
      if (searchItems.length === 0) {
        // 诊断锚点：抓到了页面但选择器没命中（引擎改版/风控页/区域跳转）时，
        // 日志里给出页面规模与标题，替代无声的"0 结果"。
        const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)
        logger.warn(
          `local search (${this.engineId}) parsed 0 results from ${content.length} chars, page title: ${titleMatch?.[1]?.trim() ?? '(none)'}`
        )
      }

      const validItems = searchItems
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
        results: results.filter((result) => result.content !== noContent)
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      logger.error('Local search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      await searchService.closeSearchWindow(uid)
    }
  }

  /**
   * 根据提供的语言为查询添加语言过滤器
   * @param query 原始查询
   * @param language 语言代码 (例如: 'zh-CN', 'en-US')
   * @returns 带有语言过滤的查询
   */
  protected applyLanguageFilter(query: string, language: string): string {
    if (this.provider.id.includes('local-google') || this.provider.id.includes('local-bing')) {
      return `${query} lang:${language.split('-')[0]}`
    }
    return query
  }

  /**
   * 搜索结果 HTML 解析（主进程无 DOM）：委托共享解析器按 engineId 分派，
   * 上游三子类的 DOM 解析查询语义逐一收敛在 searchResultParser 内。
   */
  protected parseValidUrls(htmlContent: string): Array<{ title: string; url: string }> {
    return parseSearchResults(htmlContent, this.engineId)
  }
}
