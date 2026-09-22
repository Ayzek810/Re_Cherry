import type { SearchEngineId } from '@shared/utils/searchResultParser'

import LocalSearchProvider from './LocalSearchProvider'

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 LocalBingProvider.ts）：
 * 上游 DOM 解析查询 '#b_results h2'（每个 h2 内 a 的 textContent 与 href）收敛到
 * @shared/utils/searchResultParser 的 bing 实现；/ck/a?...&u=a1<base64> 重定向解码
 * （decodeBingUrl 同语义：atob 后须以 http 开头，失败回退原值）在共享解析器内完成。
 */
export default class LocalBingProvider extends LocalSearchProvider {
  protected get engineId(): SearchEngineId {
    return 'bing'
  }
}
