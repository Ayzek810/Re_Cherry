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
import { fetchWebContent, isAbortError, noContent } from './webSearchProviders/webFetch'

const logger = loggerService.withContext('WebSearchService')

/** 单次搜索最大条数的兜底值（上游渲染层 websearch 切片初始 maxResults=5）。 */
const DEFAULT_MAX_RESULTS = 5

/**
 * 自 CS_V1 移植 + 适配点清单（源：上游
 * src/renderer/src/services/WebSearchService.ts）：
 * - 执行环境渲染层 → 主进程：Redux store（getWebSearchState）→ 配置注入制
 *   setConfig(KernelWebSearchConfig) 整体替换（Dsh_SyncWebSearch 推送）；渲染层 api 桥
 *   / window.keyv → 主进程内存态。单例导出名 webSearchService（区别于渲染层刮取的
 *   searchService）。
 * - 压缩相：cutoff 直接移植（cutoffUnit token 用近似折算，tokenx 为渲染层
 *   devDep 不在运行时闭包）；RAG 相为 fork 自建内核栈（chunker + EmbeddingClient +
 *   cosine，见 webSearchProviders/compression.ts），失败降级直供原始结果（上游是清空）。
 *   上游 setWebSearchStatus 的 runtime phase 推送（default、fetch_complete、rag 系、
 *   cutoff）为渲染层 Redux UI 关切，主进程不移植。
 *
 * 重写（验收标准：设置页控制项实质性反映在网络搜索工具的控制中）：
 * - count 权威语义：设置页「搜索结果个数」(maxResults) 是单次搜索的唯一权威上限——
 *   缺省即设置值；模型显式传入的 count 钳制到 [1, 设置值]。此前工具侧硬编码 1..12
 *   钳制：用户设 3 时模型可传大 count 突破上限，设 100（配合压缩）时被 12 无声截断，
 *   两个方向设置都不权威。引擎包装层另有终审截断兜底（providers/index.ts，防个别
 *   提供商内部不截断响应——Bocha/Querit）。
 * - RAG 预抓全页：API 型提供商返回的 snippet（数百字符）不超过一个分块窗口，每条
 *   结果至多产出 1 块，而轮转选片预算 maxRefs = 条数 × documentCount ≥ 条数——RAG
 *   在数学上只能原样通过（报告恒为 N -> N），documentCount/嵌入/重排对这类提供商
 *   从不生效。现在 RAG 激活时先对贫瘠正文抓全页（fetchWebContent 三级回退链，
 *   usingBrowser 语义保持），再进压缩相——RAG 控制项对全部提供商实质生效。
 * - check() 连通性检查走裸搜索：不过压缩相（RAG 下检查不应触发 N 次全页抓取 +
 *   嵌入调用），保持「真跑一次提供商」的诚实语义。
 * - processWebsearch（多 question 编排 + summarize 特例）删除：零调用方死码
 *   （上游 aiCore 意图分析插件的消费面，fork 内核工具路径从不经过）；主进程
 *   fetchWebContents 随之删除（唯一消费者）。
 * - searchWithTime 前缀（本地日期格式化）与每轮提供商/编号登记机制保持不变。
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

  /**
   * 本轮结果编号偏移（v0.4 验收轮）：topicId → 已产出的结果条数。同轮多次搜索
   * 接续全局编号（第二次搜索从 [offset+1] 起），模型正文 [n] 与合并后的引用卡
   * 保持同序同号；随 setTurnProvider 重置。
   */
  private turnResultOffsets = new Map<string, number>()

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
      searchWithTime: this.config.searchWithTime,
      maxResults: this.config.maxResults,
      language: this.config.language,
      compression: this.config.compression?.method ?? 'none'
    })
  }

  /** 每轮搜索提供商登记（topics.sendMessage 写入；undefined = 本轮未启用）。 */
  public setTurnProvider(topicId: string, providerId: string | undefined): void {
    this.turnProviders.set(topicId, providerId)
    this.capTurnMaps()
    // 本轮 [n] 全局编号随每轮登记重置（同轮多次搜索接续编号——修复"两次搜索
    // 两张 1-6 卡"且模型正文 [n] 与引用卡错位）。
    this.turnResultOffsets.delete(topicId)
  }

  /** web_search 工具执行时读取本轮登记的提供商。 */
  public getTurnProvider(topicId: string): string | undefined {
    return this.turnProviders.get(topicId)
  }

  /**
   * 本轮结果全局编号偏移：同轮第 N 次搜索的条目从 offset+1 起编号（调用后偏移
   * 累加 count）。工具正文编号与合并后的引用卡条目同序同号。
   */
  public bumpTurnResultOffset(topicId: string, resultCount: number): number {
    const offset = this.turnResultOffsets.get(topicId) ?? 0
    this.turnResultOffsets.set(topicId, offset + resultCount)
    return offset
  }

  /** 每话题一条小记录、长期运行下无界累积：超上限淘汰最早登记（活跃回合不可能同时超过）。 */
  private capTurnMaps(): void {
    const LIMIT = 512
    while (this.turnProviders.size > LIMIT) {
      const oldest = this.turnProviders.keys().next().value
      if (oldest === undefined) break
      this.turnProviders.delete(oldest)
      this.turnResultOffsets.delete(oldest)
    }
    while (this.turnResultOffsets.size > LIMIT) {
      const oldest = this.turnResultOffsets.keys().next().value
      if (oldest === undefined) break
      this.turnResultOffsets.delete(oldest)
    }
  }

  private findProvider(providerId: string): KernelWebSearchProviderConfig {
    const provider = this.config?.providers.find((candidate) => candidate.id === providerId)
    if (!provider) {
      throw new Error(`Web search provider not configured: ${providerId}`)
    }
    return provider
  }

  /**
   * count 权威语义：设置「搜索结果个数」是唯一权威上限。
   * 缺省 = 设置值；显式请求钳制到 [1, 设置值]——设置值以下尊重调用方收窄，
   * 以上一律压回（用户设 3 不会被模型的 count=10 突破）.
   */
  private effectiveCount(requested?: number): number {
    const cap = this.getConfiguredMaxResults()
    const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : NaN
    return Number.isFinite(n) ? Math.min(cap, Math.max(1, n)) : cap
  }

  private buildRuntime(provider: KernelWebSearchProviderConfig, count: number): WebSearchRuntimeState {
    return {
      maxResults: count,
      excludeDomains: this.config?.excludeDomains ?? [],
      blacklistPatterns: this.config?.blacklist ?? [],
      searchWithTime: this.config?.searchWithTime ?? false,
      language: this.config?.language,
      usingBrowser: provider.usingBrowser
    }
  }

  /** 上游 searchWithTime：`today is YYYY-MM-DD \r\n query` 前缀（本地时区，dayjs → 内建格式化）。 */
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
   * 单次网络搜索（内核 web_search 工具入口）：provider 分派 → 引擎搜索（引擎
   * 包装层含黑名单过滤与 maxResults 终审截断）→ 压缩相。
   * @param providerId 提供商 id（本轮登记或直调方传入）
   * @param query 搜索查询
   * @param opts.count 最大条数（缺省用设置 maxResults；超出设置值钳回，见 effectiveCount）
   * @param opts.signal 取消信号（透传到 provider HTTP、刮取窗口与 RAG 嵌入）
   */
  public async search(
    providerId: string,
    query: string,
    opts?: { count?: number; signal?: AbortSignal }
  ): Promise<WebSearchProviderResponse> {
    const provider = this.findProvider(providerId)
    const runtime = this.buildRuntime(provider, this.effectiveCount(opts?.count))
    const engine = new WebSearchEngineProvider(provider, runtime)
    const formattedQuery = this.formatQuery(query)
    const response = await engine.search(formattedQuery, { signal: opts?.signal })
    // 压缩相：用原始 query 打分（searchWithTime 前缀会污染嵌入相关性）。
    return this.applyCompression(provider, query, response, opts?.signal)
  }

  /** 压缩是否实际激活（工具侧据此决定是否放开正文的 1200 字符切片）。 */
  public isCompressionActive(): boolean {
    const compression = this.config?.compression
    if (!compression || compression.method === 'none') return false
    if (compression.method === 'cutoff') return Boolean(compression.cutoffLimit)
    return Boolean(compression.embedding)
  }

  /** 用户设置的单次搜索最大条数（设置「搜索结果个数」的权威读取口）。 */
  public getConfiguredMaxResults(): number {
    return Math.max(1, Math.trunc(this.config?.maxResults ?? DEFAULT_MAX_RESULTS))
  }

  /**
   * RAG 预抓全页：正文不足一个分块窗口（chunker DEFAULT_CHUNK_SIZE=1000
   * 字符）的结果对 RAG 无块可选，先经 fetchWebContent（三级回退链，usingBrowser
   * 语义保持）补全正文。单条抓取失败保留原 snippet（fetchWebContent 把非取消失败
   * 兜底为 noContent）；取消信号原样上抛（中途停止不该伪装成压缩失败）。
   */
  private async enrichForRag(
    results: WebSearchProviderResult[],
    provider: KernelWebSearchProviderConfig,
    signal?: AbortSignal
  ): Promise<WebSearchProviderResult[]> {
    const RAG_CHUNK_WINDOW_CHARS = 1000
    const poorCount = results.filter((r) => (r.content?.length ?? 0) < RAG_CHUNK_WINDOW_CHARS).length
    if (poorCount === 0) return results
    logger.info(`web search RAG enrichment: fetching full pages for ${poorCount} snippet-sized result(s)`)
    return Promise.all(
      results.map(async (result) => {
        if ((result.content?.length ?? 0) >= RAG_CHUNK_WINDOW_CHARS) return result
        const full = await fetchWebContent(result.url, 'markdown', provider.usingBrowser ?? false, { signal })
        // 抓取失败（noContent 兜底）或空正文 → 保留 snippet，单条失败不拖垮整轮压缩
        if (full.content === noContent || full.content.trim().length === 0) return result
        return { ...result, content: full.content }
      })
    )
  }

  private async applyCompression(
    provider: KernelWebSearchProviderConfig,
    query: string,
    response: WebSearchProviderResponse,
    signal?: AbortSignal
  ): Promise<WebSearchProviderResponse> {
    const compression = this.config?.compression
    const results = response.results ?? []
    if (!compression || compression.method === 'none' || results.length === 0) return response
    // v0.4 验收轮（静默降级禁则）：压缩失败不再无声回落原始结果——失败原因随
    // compression.error 上浮，web_search 工具文本如实报告（用户此前完全无感知）。
    if (compression.method === 'rag') {
      if (!compression.embedding) {
        return {
          ...response,
          compression: {
            method: 'rag',
            before: results.length,
            after: results.length,
            error: 'RAG compression requires an embedding model (设置 → 网络搜索 → 结果压缩)'
          }
        }
      }
      try {
        // 先补全贫瘠正文（snippet 型 API 提供商），RAG 控制项才实质生效
        const enriched = await this.enrichForRag(results, provider, signal)
        const compressed = await compressWithRag([query], enriched, compression, signal)
        // 压缩摘要随响应上行：web_search 工具据此向用户报告压缩确实启用（before→after）
        return {
          ...response,
          results: compressed,
          compression: { method: 'rag', before: results.length, after: compressed.length }
        }
      } catch (error) {
        if (isAbortError(error)) throw error
        logger.warn('web search: RAG compression failed, supplying raw results', error as Error)
        return {
          ...response,
          compression: {
            method: 'rag',
            before: results.length,
            after: results.length,
            error: error instanceof Error ? error.message : String(error)
          }
        }
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
   * results 可得即视为可用）。裸搜索不过压缩相——RAG 激活时检查不应触发全页抓取
   * 与嵌入调用，检查验证的是提供商连通性而非压缩管线。
   */
  public async check(providerId: string): Promise<boolean> {
    try {
      const provider = this.findProvider(providerId)
      const runtime = this.buildRuntime(provider, this.getConfiguredMaxResults())
      const engine = new WebSearchEngineProvider(provider, runtime)
      const response = await engine.search(this.formatQuery('test query'))
      logger.debug(`check provider ${providerId}: ${response.results.length} result(s)`)
      return response.results !== undefined
    } catch (error) {
      logger.warn(`check provider ${providerId} failed:`, error as Error)
      return false
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
