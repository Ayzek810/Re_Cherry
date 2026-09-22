import { loggerService } from '@logger'
import type {
  KernelWebSearchCompressionConfig,
  KernelWebSearchConfig,
  KernelWebSearchProviderConfig
} from '@shared/config/types'

import WebSearchEngineProvider from './webSearchProviders'
import { compressWithRag } from './webSearchProviders/compression'
import type {
  WebSearchProviderResponse,
  WebSearchProviderResult,
  WebSearchRuntimeState
} from './webSearchProviders/types'
import { fetchWebContents } from './webSearchProviders/webFetch'

const logger = loggerService.withContext('WebSearchService')

/** 单次搜索最大条数的兜底值（上游渲染层 websearch 切片初始 maxResults=5）。 */
const DEFAULT_MAX_RESULTS = 5

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游
 * src/renderer/src/services/WebSearchService.ts）：
 * - 执行环境渲染层 → 主进程：Redux store（getWebSearchState）→ 配置注入制
 *   setConfig(KernelWebSearchConfig) 整体替换（Dsh_SyncWebSearch 推送）；渲染层 api 桥 / window.keyv
 *   / window.keyv → SearchService 直调与模块内 Map（见 BaseWebSearchProvider /
 *   webFetch）。单例导出名 webSearchService（区别于渲染层刮取的 searchService）。
 * - 压缩相：cutoff 直接移植（cutoffUnit token 用近似折算，tokenx 为渲染层
 *   devDep 不在运行时闭包）；RAG 相批次7 补齐——不走上游临时知识库 IPC，改用
 *   fork 自建内核栈（chunker + EmbeddingClient + cosine，见
 *   webSearchProviders/compression.ts），失败降级直供原始结果（上游是清空）。
 *   上游 setWebSearchStatus 的 runtime phase 推送（default、fetch_complete、rag 系、cutoff）
 *   为渲染层 Redux UI 关切，主进程不移植，phase 枚举随 rag 分支一并裁掉。
 * - Summarize 特例（questions[0]==='summarize' 直接抓 links 正文）：走主进程 webFetch
 *   （先直 fetch，失败回退 SearchService 刮取；usingBrowser=true 直接刮取）。
 * - 上游 checkSearch 返回 {valid, error} → 内核 IPC 需要布尔，收敛为 check(): boolean。
 * - dayjs（devDep）→ 内建本地日期格式化（searchWithTime 前缀）。
 * - processWebsearch 保留上游多 question 并行编排（Promise.allSettled、任一 rejected
 *   即抛、空结果短路、cutoff 压缩）；当前内核 web_search 工具走单 query 的 search()。
 */
export class WebSearchService {
  private static instance: WebSearchService | null = null
  public static getInstance(): WebSearchService {
    if (!WebSearchService.instance) {
      WebSearchService.instance = new WebSearchService()
    }
    return WebSearchService.instance
  }

  /** 渲染层 websearch 切片的同步投影（setConfig 整体替换）。 */
  private config: KernelWebSearchConfig | null = null

  /**
   * 每轮上下文登记：topicId → 本轮网络搜索提供商（即设即覆盖，无清理需求——
   * topics.sendMessage 按发送参数写入，web_search 工具执行时读取）。
   */
  private turnProviders = new Map<string, string | undefined>()

  /** 渲染层 websearch 切片 → 引擎配置投影（启动与切片变更时整体替换）。 */
  public setConfig(config: KernelWebSearchConfig): void {
    // 拷贝防投影侧后续原地修改；apiKey 只存本进程内存
    this.config = {
      providers: (config.providers ?? []).map((provider) => ({ ...provider })),
      blacklist: [...(config.blacklist ?? [])],
      excludeDomains: [...(config.excludeDomains ?? [])],
      searchWithTime: config.searchWithTime,
      maxResults: config.maxResults,
      language: config.language,
      compression: config.compression ? { ...config.compression } : undefined
    }
    logger.info('web search config set', {
      providers: this.config.providers.length,
      blacklistPatterns: this.config.blacklist.length,
      excludeDomains: this.config.excludeDomains.length,
      searchWithTime: this.config.searchWithTime
    })
  }

  /** 每轮搜索提供商登记（topics.sendMessage 写入；undefined = 本轮未启用）。 */
  public setTurnProvider(topicId: string, providerId: string | undefined): void {
    this.turnProviders.set(topicId, providerId)
  }

  /** web_search 工具执行时读取本轮登记的提供商。 */
  public getTurnProvider(topicId: string): string | undefined {
    return this.turnProviders.get(topicId)
  }

  private findProvider(providerId: string): KernelWebSearchProviderConfig {
    const provider = this.config?.providers.find((candidate) => candidate.id === providerId)
    if (!provider) {
      throw new Error(`Web search provider not configured: ${providerId}`)
    }
    return provider
  }

  private buildRuntime(provider: KernelWebSearchProviderConfig, count?: number): WebSearchRuntimeState {
    return {
      maxResults: Math.max(1, Math.trunc(count ?? this.config?.maxResults ?? DEFAULT_MAX_RESULTS)),
      excludeDomains: this.config?.excludeDomains ?? [],
      blacklistPatterns: this.config?.blacklist ?? [],
      searchWithTime: this.config?.searchWithTime ?? false,
      language: this.config?.language,
      usingBrowser: provider.usingBrowser
    }
  }

  /** 上游 searchWithTime：`today is ${dayjs().format('YYYY-MM-DD')} \r\n ${query}`（本地时区）。 */
  private formatQuery(query: string): string {
    if (this.config?.searchWithTime) {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const date = String(now.getDate()).padStart(2, '0')
      return `today is ${now.getFullYear()}-${month}-${date} \r\n ${query}`
    }
    return query
  }

  /**
   * 单次网络搜索（内核 web_search 工具入口）：provider 分派 → 引擎搜索 → 黑名单过滤。
   * @param providerId 提供商 id（本轮登记或直调方传入）
   * @param query 搜索查询
   * @param opts.count 最大条数（缺省用 config.maxResults）
   * @param opts.signal 取消信号（透传到 provider HTTP 与刮取窗口）
   */
  public async search(
    providerId: string,
    query: string,
    opts?: { count?: number; signal?: AbortSignal }
  ): Promise<WebSearchProviderResponse> {
    const provider = this.findProvider(providerId)
    const runtime = this.buildRuntime(provider, opts?.count)
    const engine = new WebSearchEngineProvider(provider, runtime)
    const formattedQuery = this.formatQuery(query)
    const response = await engine.search(formattedQuery, { signal: opts?.signal })
    // 压缩相（批次7：内核 web_search 工具路径此前从不压缩——cutoff 只活在无
    // 调用方的 processWebsearch 里）。用原始 query 打分（searchWithTime 前缀会
    // 污染嵌入相关性）。
    return this.applyCompression(query, response, opts?.signal)
  }

  /** 压缩是否实际激活（工具侧据此决定是否放开正文的 1200 字符切片）。 */
  public isCompressionActive(): boolean {
    const compression = this.config?.compression
    if (!compression || compression.method === 'none') return false
    if (compression.method === 'cutoff') return Boolean(compression.cutoffLimit)
    return Boolean(compression.embedding)
  }

  private async applyCompression(
    query: string,
    response: WebSearchProviderResponse,
    signal?: AbortSignal
  ): Promise<WebSearchProviderResponse> {
    const compression = this.config?.compression
    const results = response.results ?? []
    if (!compression || compression.method === 'none' || results.length === 0) return response
    if (compression.method === 'rag') {
      const compressed = await compressWithRag([query], results, compression, signal)
      // 压缩摘要随响应上行：web_search 工具据此向用户报告压缩确实启用（before→after）
      return {
        ...response,
        results: compressed,
        compression: { method: 'rag', before: results.length, after: compressed.length }
      }
    }
    if (compression.method === 'cutoff' && compression.cutoffLimit) {
      const compressed = compressWithCutoff(results, compression)
      return {
        ...response,
        results: compressed,
        compression: { method: 'cutoff', before: results.length, after: compressed.length }
      }
    }
    return response
  }

  /**
   * 连通性检查：'test query' 真跑一次（同一条真实执行路径，上游 checkSearch 语义，
   * results 可得即视为可用）。
   */
  public async check(providerId: string): Promise<boolean> {
    try {
      const response = await this.search(providerId, 'test query')
      logger.debug(`check provider ${providerId}: ${response.results.length} result(s)`)
      return response.results !== undefined
    } catch (error) {
      logger.warn(`check provider ${providerId} failed:`, error as Error)
      return false
    }
  }

  /**
   * 多 question 编排（上游 processWebsearch 语义移植；当前无内核调用方，供后续
   * 批次与直调使用）：
   * - questions[0]==='summarize' 且带 links → 直接抓取链接正文（query='summaries'）
   * - 多 question 并行 Promise.allSettled，任一 rejected 即抛
   * - 全部为空 → {query: questions.join(' | '), results: []}
   * - 压缩仅 cutoff（RAG 相不移植）
   */
  public async processWebsearch(
    providerId: string,
    questions: string[],
    opts?: { links?: string[]; count?: number; signal?: AbortSignal }
  ): Promise<WebSearchProviderResponse> {
    if (!questions || questions.length === 0 || !questions[0] || questions[0].length === 0) {
      logger.info('No valid question found')
      return { results: [] }
    }

    const provider = this.findProvider(providerId)
    const signal = opts?.signal

    // 处理 summarize：直接抓取链接正文
    if (questions[0] === 'summarize' && opts?.links && opts.links.length > 0) {
      const contents = await fetchWebContents(opts.links, 'markdown', provider.usingBrowser ?? false, { signal })
      return { query: 'summaries', results: contents }
    }

    const searchPromises = questions.map((q) => this.search(providerId, q, { count: opts?.count, signal }))
    const searchResults = await Promise.allSettled(searchPromises)

    const successfulSearchCount = searchResults.filter((result) => result.status === 'fulfilled').length
    logger.debug(`Successful search count: ${successfulSearchCount}`)

    let finalResults: WebSearchProviderResult[] = []
    searchResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        if (result.value.results) {
          finalResults.push(...result.value.results)
        }
      }
      if (result.status === 'rejected') {
        throw result.reason
      }
    })

    logger.debug(`Fulfilled search result count: ${finalResults.length}`)

    // 如果没有搜索结果，直接返回空结果
    if (finalResults.length === 0) {
      return {
        query: questions.join(' | '),
        results: []
      }
    }

    // 压缩相（批次7：RAG 分支补齐——fork 自建内核栈实现，失败降级直供原始结果；
    // cutoffLimit 未配置时跳过，与上游一致）
    const compression = this.config?.compression
    if (compression?.method === 'rag') {
      finalResults = await compressWithRag(questions, finalResults, compression, signal)
    } else if (compression?.method === 'cutoff' && compression.cutoffLimit) {
      finalResults = compressWithCutoff(finalResults, compression)
    }

    return {
      query: questions.join(' | '),
      results: finalResults
    }
  }
}

/**
 * 截断压缩（上游 compressWithCutoff 同语义）。cutoffUnit==='token' 时 tokenx
 * （渲染层 devDep，主进程运行时闭包不含）不可用，用近似折算：CJK 字符按
 * 1 token、其余按每 4 字符 1 token 计字符预算（宁欠勿过，避免过度丢内容）。
 */
function compressWithCutoff(
  rawResults: WebSearchProviderResult[],
  config: KernelWebSearchCompressionConfig
): WebSearchProviderResult[] {
  if (!config.cutoffLimit) {
    logger.warn('Cutoff limit is not set, skipping compression')
    return rawResults
  }

  const perResultLimit = Math.max(1, Math.floor(config.cutoffLimit / rawResults.length))

  return rawResults.map((result) => {
    if (config.cutoffUnit === 'token') {
      // 使用 token 截断（近似折算，见函数头注释）
      const slicedContent = sliceByTokensApprox(result.content, perResultLimit)
      return {
        ...result,
        content: slicedContent.length < result.content.length ? slicedContent + '...' : slicedContent
      }
    } else {
      // 使用字符截断（默认行为）
      return {
        ...result,
        content:
          result.content.length > perResultLimit ? result.content.slice(0, perResultLimit) + '...' : result.content
      }
    }
  })
}

const CJK_CHARRegExp = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

function sliceByTokensApprox(content: string, limitTokens: number): string {
  let tokens = 0
  for (let index = 0; index < content.length; index++) {
    tokens += CJK_CHARRegExp.test(content[index]) ? 1 : 0.25
    if (tokens > limitTokens) {
      return content.slice(0, index)
    }
  }
  return content
}

/** 引擎单例（内核 ctx.webSearch 缝与 web_search 工具直用的入口）。 */
export const webSearchService = WebSearchService.getInstance()
