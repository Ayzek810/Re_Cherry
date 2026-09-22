/**
 * web_search 内核 builtin 工具（批次2 网络搜索接线）。
 *
 * 上游 v1.9.11 同构形态：搜索以模型工具面呈现（其 aiCore 的 builtin_web_search
 * 工具 + 意图分析插件），fork 内核路径落在 BUILTIN_MOUNTS 数据驱动挂载表——
 * 渲染层 messageThunk 在助手网络搜索开启（webSearchProviderId 就绪）的轮把
 * 'web_search' 并入 builtinTools 随发送参数上行，工具面跟轮走（下一轮生效）。
 *
 * 执行：主进程引擎单例（../services/WebSearchService）按每轮登记的提供商发起
 * 搜索（API 型直连 HTTP；local-* 走 SearchService 隐藏窗口刮取 + 共享结果解析），
 * 结果经黑名单过滤后以 [n] 标号文本回给模型（模型可继续调本工具精炼 query）。
 * UI 侧：通用工具卡由 kernelChat 投影自动覆盖；presentationMeta 把结构化条目随
 * tool/result 上行给统一引用机制（3b99bf8），搜索结果审阅走工具卡内容区。
 *
 * MVP 边界（批次2）：不做上游的 LLM 意图分析预调用（模型自行按对话拟 query）；
 * 压缩相（cutoff / RAG）由引擎层 applyCompression 内联（webSearchProviders/
 * compression.ts），按渲染层设置的 compressionConfig 全局生效；模型原生搜索轨
 *（enableWebSearch
 * 无 providerId 的 provider 专参管道）未接，见到即拒答明错。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { webSearchService } from '../services/WebSearchService'

const logger = loggerService.withContext('WebSearchTool')

export const name = 'tool-web-search'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Search the public web for current information. Use this whenever the conversation needs facts that may ' +
  'have changed after your training data ends, or explicit web sources are requested: news, prices, release ' +
  'notes, documentation updates, weather, scores. Craft a focused keyword query (proper nouns, version ' +
  'numbers, exact phrases work best). Results come back as numbered entries with title, URL and a content ' +
  'excerpt; cite them inline as [n] when you use them. Repeat calls with refined queries are allowed.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'web_search',
      description: DESCRIPTION,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The web search query. Keep it focused; search again with rephrased terms if results are poor.'
        },
        count: {
          type: 'number',
          description: 'Maximum number of results to return (default 6).'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            results: { type: 'number', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  content: { type: 'string', required: true }
                }
              }
            },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        // 统一引用机制（V2 迁移）：结构化结果随 tool/result 事件 meta 上行（内核
        // 正规通道，持久化、回放复现）——渲染层 kernelChat 据此建引用数据载体，
        // 正文 [n] 药丸 + 悬浮胶囊同源。形状 {kind:'web-search', results:[…]}。
        presentationMeta: (_args, value) => ({
          kind: 'web-search',
          results: value.entries ?? []
        })
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const query = String(args.query ?? '').trim()
        if (query.length === 0) {
          throw new Error('web_search: empty query')
        }
        // 每轮提供商登记由 topics.sendMessage 写入；缺登记 = 本轮未启用网络搜索，
        // 执行侧防线拒答（与 describe_images 的双层门同型）。
        const topicId = exec.agent?.session?.id
        const providerId = topicId === undefined ? undefined : webSearchService.getTurnProvider(topicId)
        if (providerId === undefined) {
          throw new Error('web_search: no web search provider is configured for this conversation turn')
        }
        const count =
          typeof args.count === 'number' && Number.isFinite(args.count) ? Math.max(1, Math.trunc(args.count)) : 6
        const result = await webSearchService.search(providerId, query, { count, signal: exec.signal })
        logger.info(
          `web_search: "${query}" via ${providerId} -> ${result.results.length} results` +
            (result.compression
              ? ` (compression ${result.compression.method}: ${result.compression.before} -> ${result.compression.after})`
              : '')
        )
        // [n] 标号文本：与上游 toModelOutput 的引用指令同语义（模型按 [n] 引用）。
        // 压缩关闭时单条正文截 1200 字符防原始抓取失控；压缩开启时正文已被
        // cutoff/RAG 控量，放开切片（否则把压缩成果又裁没了）。
        const sliceLimit = webSearchService.isCompressionActive() ? Number.MAX_SAFE_INTEGER : 1200
        // 压缩状态明示（用户此前无法判断 RAG/cutoff 是否真的启用）：有摘要即报
        // 方法名与前后条数；未压缩不出现该行。
        const compressionLine = result.compression
          ? [
              `Compression: ${result.compression.method} applied (${result.compression.before} -> ${result.compression.after} results).`
            ]
          : []
        const text =
          result.results.length === 0
            ? `No web results found for "${query}". Try different keywords.`
            : [
                `Web results for "${query}" (cited as [n]):`,
                ...compressionLine,
                ...result.results.map(
                  (r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content?.slice(0, sliceLimit) ?? ''}`
                ),
                'Citation rule: in your answer, place the matching [n] marker immediately after each statement these results support.'
              ].join('\n\n')
        return {
          query,
          provider: providerId,
          results: result.results.length,
          entries: result.results.map((r) => ({ title: r.title, url: r.url, content: r.content ?? '' })),
          text
        }
      }
    })
  )
}
