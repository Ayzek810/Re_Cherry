export type FileChangeEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'refresh'

export type FileChangeEvent = {
  eventType: FileChangeEventType
  filePath: string
  watchPath: string
}

export type WebviewKeyEvent = {
  webviewId: number
  key: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

export type MCPServerLogEntry = {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error' | 'stderr' | 'stdout'
  message: string
  data?: any
  source?: string
}

/** 网络搜索提供商的内核侧最小配置（批次2：渲染层 websearch 切片的同步投影）。 */
export type KernelWebSearchProviderConfig = {
  id: string
  name: string
  apiKey?: string
  apiHost?: string
  /** true = 网页正文抓取强制走主进程隐藏窗口刮取（上游 usingBrowser 语义）。 */
  usingBrowser?: boolean
  /**
   * 本地搜索引擎（local-google / local-bing / local-baidu）的搜索 URL 模板，
   * '%s' 为 URL 编码后的查询占位符（上游 WebSearchProvider.url 语义）。
   */
  url?: string
  /** SearxNG 私有实例 Basic 认证（上游 basicAuthUsername / basicAuthPassword）。 */
  basicAuthUsername?: string
  basicAuthPassword?: string
}

/**
 * 搜索结果压缩配置（上游 CompressionConfig 适配版）：method 全量三态——rag 相
 * 由 fork 自建知识库内核栈实现（chunker/EmbeddingClient/cosine，不走上游的临时
 * 知识库 IPC）；embedding 收窄为模型引用（主进程自解析密钥，同知识库先例）。
 */
export type KernelWebSearchCompressionConfig = {
  method: 'none' | 'cutoff' | 'rag'
  cutoffLimit?: number
  cutoffUnit?: 'char' | 'token'
  /** RAG：每条结果保留的相关块数（上游 DEFAULT_WEBSEARCH_RAG_DOCUMENT_COUNT=1）。 */
  documentCount?: number
  /** RAG 必需：嵌入模型引用（渲染层 embeddingModel: Model 投影收窄）。 */
  embedding?: { providerId: string; modelId: string; dimensions?: number }
  /**
   * RAG 可选：重排模型引用（渲染层 rerankModel: Model 投影收窄）。配置后 cosine
   * 初筛的候选块再经 lightRerank 精排；失败降级 cosine 序（如实记 warn）。
   */
  rerank?: { providerId: string; modelId: string }
}

/**
 * 网络搜索内核配置（Dsh_SyncWebSearch 载荷）：渲染层 websearch 切片 → 主进程
 * WebSearchService 的一份投影。apiKey 只进主进程内存，不落内核 settings.json。
 */
export type KernelWebSearchConfig = {
  providers: KernelWebSearchProviderConfig[]
  /** 全局黑名单（订阅源 ublacklist 语法模式串，filterResultWithBlacklist 消费）。 */
  blacklist: string[]
  /** 全局排除域（纯域名串；与 blacklist 并行过滤）。 */
  excludeDomains: string[]
  /** 结果附搜索时间戳（上游 search-with-time 设置）。 */
  searchWithTime: boolean
  /** 默认结果条数（工具未显式传 count 时使用）。 */
  maxResults: number
  /** 界面语言（BCP-47，如 'zh-CN'）——local-google / local-bing 追加 lang: 过滤用（上游 settings.language）。 */
  language?: string
  /** 结果压缩（none / cutoff / rag 三相，见 KernelWebSearchCompressionConfig；缺省 none）。 */
  compression?: KernelWebSearchCompressionConfig
}
