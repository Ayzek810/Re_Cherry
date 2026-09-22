import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 DefaultProvider.ts）：
 * 兜底 provider，原样保留未实现明错（未知 provider id 落到这里）。
 */
export default class DefaultProvider extends BaseWebSearchProvider {
  search(
    _query: string,
    _websearch: WebSearchRuntimeState,
    _httpOptions?: WebSearchHttpOptions
  ): Promise<WebSearchProviderResponse> {
    throw new Error('Method not implemented.')
  }
}
