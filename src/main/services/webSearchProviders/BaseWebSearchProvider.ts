import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'

const logger = loggerService.withContext('BaseWebSearchProvider')

/**
 * 多 apiKey 轮换的内存态轮转指针（v0.3.2 批次2 适配）。
 * 上游经 window.keyv 按 'web-search-provider:<id>:last_used_key' 记录上次使用的
 * key 顺序取下一个；主进程无 keyv，改为模块级 Map<providerId, index>（内存态，
 * 进程重启即重置，轮换顺序语义与上游一致）。
 */
const lastUsedKeyIndexByProvider = new Map<string, number>()

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 BaseWebSearchProvider.ts）：
 * - provider 类型换 KernelWebSearchProviderConfig（配置注入制）。
 * - window.keyv 多 key 轮换 → 模块级 Map 轮转指针（见上）。
 * - WebSearchState → 本地 WebSearchRuntimeState（./types）。
 */
export default abstract class BaseWebSearchProvider {
  protected provider: KernelWebSearchProviderConfig
  protected apiHost?: string
  protected apiKey: string

  constructor(provider: KernelWebSearchProviderConfig) {
    this.provider = provider
    this.apiHost = this.getApiHost()
    this.apiKey = this.getApiKey()
  }

  abstract search(
    query: string,
    websearch: WebSearchRuntimeState,
    httpOptions?: WebSearchHttpOptions
  ): Promise<WebSearchProviderResponse>

  public getApiHost() {
    return this.provider.apiHost
  }

  public defaultHeaders() {
    return {
      'HTTP-Referer': 'https://cherry-ai.com',
      'X-Title': 'Cherry Studio'
    }
  }

  public getApiKey() {
    const keys = this.provider.apiKey?.split(',').map((key) => key.trim()) || []

    if (keys.length === 1) {
      return keys[0] ?? ''
    }

    if (keys.length === 0) {
      return ''
    }

    // 上游：keyv 无记录时取 keys[0]，否则按上次 key 的下一轮换；等价的数字指针实现
    const index = lastUsedKeyIndexByProvider.get(this.provider.id) ?? 0
    const nextKey = keys[index] ?? keys[0] ?? ''
    lastUsedKeyIndexByProvider.set(this.provider.id, (index + 1) % keys.length)
    logger.debug(`rotated api key for provider ${this.provider.id}, using key #${index}`)
    return nextKey
  }
}
