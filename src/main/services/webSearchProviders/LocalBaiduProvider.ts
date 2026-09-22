import type { SearchEngineId } from '@shared/utils/searchResultParser'

import LocalSearchProvider from './LocalSearchProvider'

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 LocalBaiduProvider.ts）：
 * 上游 DOM 解析查询 '#content_left .result h3'（每个 h3 内 a 的 textContent 与
 * href，href 原样透传）收敛到 @shared/utils/searchResultParser 的 baidu 实现。
 */
export default class LocalBaiduProvider extends LocalSearchProvider {
  protected get engineId(): SearchEngineId {
    return 'baidu'
  }
}
