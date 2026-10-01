/**
 * web_search 内核 builtin 工具（网络搜索接线）。
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
 * MVP 边界：不做上游的 LLM 意图分析预调用（模型自行按对话拟 query）；
 * 压缩相（cutoff / RAG）由引擎层 applyCompression 内联（webSearchProviders/
 * compression.ts），按渲染层设置的 compressionConfig 全局生效；模型原生搜索轨
 *（enableWebSearch
 * 无 providerId 的 provider 专参管道）未接，见到即拒答明错。
 *
 * （设置控制项实质生效）：count 不再在工具侧钳制——设置页「搜索结果个数」
 * (maxResults) 是唯一权威上限，缺省即设置值，模型显式 count 由引擎服务统一钳到
 * [1, 设置值]（此前硬编码 1..12：设置 3 可被突破、设置 100 被 12 无声截断）。
 * RAG 压缩对 snippet 型提供商现经全页预抓实质生效（见 services/WebSearchService）。
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
  'Search the public web for current information. Use it when the conversation needs facts that may have ' +
  'changed after your training data ends, or when the user asks for web sources: news, prices, release ' +
  'notes, documentation updates, weather, scores. Send a focused keyword query; proper nouns and version ' +
  'numbers work best. Results come back as numbered entries with title, URL and an excerpt; cite them ' +
  'inline as [n]. Search again with refined terms if the results are poor.'

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
          description:
            'Maximum number of results. Omit to use the user-configured value; higher values are clamped to it.'
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
        if (topicId === undefined || providerId === undefined) {
          throw new Error('web_search: no web search provider is configured for this conversation turn')
        }
        // count 权威语义收敛进引擎服务（effectiveCount）——设置 maxResults 是
        // 唯一权威上限，缺省即设置值，模型显式 count 由服务统一钳到 [1, 设置值]。
        // 工具侧只负责把模型参数原样（或 undefined）下传，不再自带硬编码钳制。
        const count = typeof args.count === 'number' && Number.isFinite(args.count) ? Math.trunc(args.count) : undefined
        // 引擎抛出（提供商未就绪 / 网络断 / 引擎不可用）与"真的搜到 0 条"是两件事：
        // 前者**必须**以失败上行，不得折叠成"No web results found"。
        let result: Awaited<ReturnType<typeof webSearchService.search>>
        try {
          result = await webSearchService.search(providerId, query, { count, signal: exec.signal })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`web_search: search failed via provider "${providerId}": ${reason}`)
        }
        // 同轮多次搜索的全局编号偏移（每轮发送时重置）。
        const offset = webSearchService.bumpTurnResultOffset(topicId, result.results.length)
        logger.info(
          `web_search: "${query}" via ${providerId} -> ${result.results.length} results` +
            (result.compression
              ? ` (compression ${result.compression.method}: ${result.compression.before} -> ${result.compression.after})`
              : '')
        )
        // [n] 标号文本：与上游 toModelOutput 的引用指令同语义（模型按 [n] 引用）。
        // 压缩关闭时单条正文截 1200 字符防原始抓取失控；压缩开启且成功时正文已被
        // cutoff/RAG 控量，放开切片（否则把压缩成果又裁没了）；压缩失败回落 1200。
        const sliceLimit =
          webSearchService.isCompressionActive() && result.compression?.error === undefined
            ? Number.MAX_SAFE_INTEGER
            : 1200
        // 压缩状态明示（用户此前无法判断 RAG/cutoff 是否真的启用）：有摘要即报
        // 方法名与前后条数；未压缩不出现该行。
        const compressionLine = result.compression
          ? [
              result.compression.error !== undefined
                ? `Compression: ${result.compression.method} FAILED (${result.compression.error}) — results are uncompressed.`
                : `Compression: ${result.compression.method} applied (${result.compression.before} -> ${result.compression.after} results).`
            ]
          : []
        const text =
          result.results.length === 0
            ? `No web results found for "${query}". Try different keywords.`
            : [
                `Web results for "${query}" (cited as [n]):`,
                ...compressionLine,
                // v0.4 验收轮：同轮多次搜索接续全局编号（第二次搜索 [offset+1] 起），
                // 模型正文 [n] 与合并后的单一引用卡同序同号。
                ...result.results.map(
                  (r, i) => `[${offset + i + 1}] ${r.title}\n${r.url}\n${r.content?.slice(0, sliceLimit) ?? ''}`
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
