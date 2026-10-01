import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import type BaseWebSearchProvider from './BaseWebSearchProvider'
import { filterResultWithBlacklist } from './blacklistMatchPattern'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'
import WebSearchProviderFactory from './WebSearchProviderFactory'

/**
 * 自 CS_V1 移植 + 适配点清单（源：上游 providers/WebSearchProvider/index.ts
 * 的 WebSearchEngineProvider）：
 * - 上游 search 外包 withSpanResult 追踪（渲染层 SpanManagerService）；主进程无该设施，
 *   直接调用（fork 的 mcp-trace 追踪面不在本路径）。
 * - filterResultWithBlacklist 用主进程同语义实现（./blacklistMatchPattern）：ublacklist
 *   模式串（runtime.blacklistPatterns）与纯排除域（runtime.excludeDomains）两路并行过滤。
 * - 构造期注入 runtime（WebSearchRuntimeState），上游逐调用传 websearch 参数收敛为实例态。
 *
 * maxResults 终审截断。设置页「搜索结果个数」是权威上限（count 权威语义，
 * 见 WebSearchService.effectiveCount），但个别提供商不在内部截断响应（Bocha/Querit
 * 直接映射服务端返回），这里统一兜底 slice，防提供商实现疏漏绕过设置。
 */
export default class WebSearchEngineProvider {
  private sdk: BaseWebSearchProvider
  private runtime: WebSearchRuntimeState

  constructor(provider: KernelWebSearchProviderConfig, runtime: WebSearchRuntimeState) {
    this.sdk = WebSearchProviderFactory.create(provider)
    this.runtime = runtime
  }

  public async search(query: string, httpOptions?: WebSearchHttpOptions): Promise<WebSearchProviderResponse> {
    const result = await this.sdk.search(query, this.runtime, httpOptions)

    const filtered = await filterResultWithBlacklist(result, {
      blacklist: this.runtime.blacklistPatterns,
      excludeDomains: this.runtime.excludeDomains
    })

    // maxResults 终审截断（黑名单过滤后执行——过滤产生的短清单不再回填，同上游）
    if (filtered.results.length > this.runtime.maxResults) {
      return { ...filtered, results: filtered.results.slice(0, this.runtime.maxResults) }
    }
    return filtered
  }
}
