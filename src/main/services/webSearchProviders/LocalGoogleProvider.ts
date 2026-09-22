import type { SearchEngineId } from '@shared/utils/searchResultParser'

import LocalSearchProvider from './LocalSearchProvider'

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 LocalGoogleProvider.ts）：
 * 上游 DOM 解析查询 '#search .MjjYud'（块内 h3 textContent + a href）收敛到
 * @shared/utils/searchResultParser 的 google 实现（主进程无 DOM；/url?q= 跟踪链接
 * 解码见共享解析器 normalizeGoogleHref）。
 */
export default class LocalGoogleProvider extends LocalSearchProvider {
  protected get engineId(): SearchEngineId {
    return 'google'
  }
}
