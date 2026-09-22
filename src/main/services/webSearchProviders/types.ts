/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单：
 * - 上游 provider 层消费渲染层 types 的 WebSearchProviderResult/Response 与
 *   渲染层 store/websearch 的 WebSearchState；主进程禁渲染层 import，这里按
 *   provider 实际消费字段收窄为本文件最小结构类型（配置注入制，无 Redux）。
 * - WebSearchRuntimeState.excludeDomains 为纯域名串（Bocha exclude / Querit
 *   sites.exclude 的 API 级排除）；ublacklist 模式串走 blacklistPatterns，由
 *   WebSearchEngineProvider 统一做黑名单过滤（./blacklistMatchPattern）。
 */

export type WebSearchProviderResult = {
  title: string
  url: string
  content: string
}

export type WebSearchProviderResponse = {
  query?: string
  results: WebSearchProviderResult[]
  /** 压缩摘要（WebSearchService.applyCompression 实际生效时附加；none/未压缩无此字段）。
   * web_search 工具据此在结果文本里向用户报告压缩启用状态与前后条数。 */
  compression?: { method: string; before: number; after: number }
}

/** 主进程 fetch 的透传选项（abortsignal 一路透传到 provider 的 HTTP 请求与刮取窗口）。 */
export type WebSearchHttpOptions = {
  signal?: AbortSignal
}

/** 上游 WebSearchState 的 provider 消费面收窄。 */
export type WebSearchRuntimeState = {
  maxResults: number
  /** API 级排除域（纯域名）。 */
  excludeDomains: string[]
  /** 全局黑名单模式串（ublacklist 语法 / /regex/ 形态），过滤在引擎包装层统一做。 */
  blacklistPatterns: string[]
  searchWithTime: boolean
  /** 界面语言（BCP-47）——local-google / local-bing 的 lang: 过滤。 */
  language?: string
  /** true = 网页正文抓取强制走 SearchService 隐藏窗口刮取。 */
  usingBrowser?: boolean
}
