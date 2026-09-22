import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import type BaseWebSearchProvider from './BaseWebSearchProvider'
import BochaProvider from './BochaProvider'
import DefaultProvider from './DefaultProvider'
import ExaMcpProvider from './ExaMcpProvider'
import ExaProvider from './ExaProvider'
import LocalBaiduProvider from './LocalBaiduProvider'
import LocalBingProvider from './LocalBingProvider'
import LocalGoogleProvider from './LocalGoogleProvider'
import QueritProvider from './QueritProvider'
import SearxngProvider from './SearxngProvider'
import TavilyProvider from './TavilyProvider'
import ZhipuProvider from './ZhipuProvider'

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 WebSearchProviderFactory.ts）：
 * provider id → provider 实例的分派表原样保留；provider 类型换
 * KernelWebSearchProviderConfig（配置注入制）。
 */
export default class WebSearchProviderFactory {
  static create(provider: KernelWebSearchProviderConfig): BaseWebSearchProvider {
    switch (provider.id) {
      case 'zhipu':
        return new ZhipuProvider(provider)
      case 'tavily':
        return new TavilyProvider(provider)
      case 'bocha':
        return new BochaProvider(provider)
      case 'searxng':
        return new SearxngProvider(provider)
      case 'exa':
        return new ExaProvider(provider)
      case 'exa-mcp':
        return new ExaMcpProvider(provider)
      case 'querit':
        return new QueritProvider(provider)
      case 'local-google':
        return new LocalGoogleProvider(provider)
      case 'local-baidu':
        return new LocalBaiduProvider(provider)
      case 'local-bing':
        return new LocalBingProvider(provider)
      default:
        return new DefaultProvider(provider)
    }
  }
}
