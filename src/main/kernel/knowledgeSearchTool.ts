/**
 * knowledge_search 内核 builtin 工具（批次4 知识库接线）。
 *
 * 上游 v1.9.11 双形态（发送前改写 user 消息 + aiCore knowledge_search 工具）中，
 * fork 因不变量2（渲染层是投影、内核日志唯一真相源——发送前改写会让检索结果
 * 不进会话日志）只取工具形态：BUILTIN_MOUNTS 数据驱动挂载，渲染层 messageThunk
 * 在助手挂知识库的轮把 'knowledge_search' 并入 builtinTools 并随发送参数登记
 * 本轮库清单（knowledgeKernelService.setTurnBases）。
 *
 * 执行：主进程 KnowledgeService 进程内直调（嵌入 → 余弦检索 → 多库合并 → [n]
 * 标号文本，[1][2] 引用指令同 web_search 语义）。阈值过滤在服务返回后按库执行
 *（上游渲染层语义的等价内移）。UI 侧统一工具卡展示（kernelChat 投影自动覆盖）；
 * presentationMeta 把结构化条目随 tool/result 上行给统一引用机制（3b99bf8）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { knowledgeService } from '../services/knowledge/KnowledgeService'
import { lightRerank } from './lightLlmModalities'

const logger = loggerService.withContext('KnowledgeSearchTool')

export const name = 'tool-knowledge-search'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Search the user connected knowledge bases for relevant document fragments. Use this when the question ' +
  "likely depends on the user's own documents or notes. Craft a focused natural-language query; results " +
  'come back as numbered fragments with their source. Cite them inline as [n] when you use them. If nothing ' +
  'relevant is returned, say so instead of inventing content.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'knowledge_search',
      description: DESCRIPTION,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The search query against the knowledge bases. Rephrase and retry if the first results are weak.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            bases: { type: 'number', required: true },
            results: { type: 'number', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  content: { type: 'string', required: true }
                }
              }
            },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        // 统一引用机制（V2 迁移）：同 webSearchTool 的 meta 通道，知识库形态
        // {kind:'knowledge', results:[{id, source, content}]}——两形态同管线。
        presentationMeta: (_args, value) => ({
          kind: 'knowledge',
          results: value.entries ?? []
        })
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const query = String(args.query ?? '').trim()
        if (query.length === 0) {
          throw new Error('knowledge_search: empty query')
        }
        // 每轮登记由 topics.sendMessage 写入；缺登记 = 本轮未挂知识库，执行侧防线拒答。
        const topicId = exec.agent?.session?.id
        const bases = topicId === undefined ? undefined : knowledgeService.getTurnBases(topicId)
        if (bases === undefined || bases.length === 0) {
          throw new Error('knowledge_search: no knowledge bases are attached to this conversation turn')
        }
        const merged: Array<{ score: number; source: string; pageContent: string; baseId: string }> = []
        const errors: string[] = []
        for (const base of bases) {
          try {
            const hits = await knowledgeService.search(
              {
                id: base.id,
                chunkSize: base.chunkSize,
                chunkOverlap: base.chunkOverlap,
                documentCount: base.documentCount
              },
              base.embedding,
              query,
              exec.signal
            )
            const threshold = base.threshold ?? 0
            const hitsInBase: Array<{ score: number; source: string; pageContent: string; baseId: string }> = []
            for (const hit of hits) {
              if (hit.score >= threshold) {
                hitsInBase.push({
                  score: hit.score,
                  source: String(hit.metadata?.source ?? base.id),
                  pageContent: hit.pageContent,
                  baseId: base.id
                })
              }
            }
            // 重排相（批次2 rerank 实装）：库配置了 rerank 模型时，cosine 命中按
            // lightRerank 精排重序（score 换为重排分；失败降级 cosine 序，如实记 warn）。
            if (base.rerank !== undefined && hitsInBase.length > 1) {
              try {
                const reranked = await lightRerank(
                  {
                    providerId: base.rerank.providerId,
                    modelId: base.rerank.modelId,
                    query,
                    documents: hitsInBase.map((hit) => hit.pageContent)
                  },
                  exec.signal
                )
                const reordered = reranked.results
                  .map((entry) => ({ hit: hitsInBase[entry.index], score: entry.score }))
                  .filter((entry): entry is { hit: (typeof hitsInBase)[number]; score: number } => entry.hit !== undefined)
                hitsInBase.length = 0
                hitsInBase.push(...reordered.map((entry) => ({ ...entry.hit, score: entry.score })))
                logger.debug(`knowledge_search: base ${base.id} reranked ${hitsInBase.length} hit(s)`)
              } catch (error) {
                logger.warn(`knowledge_search: base ${base.id} rerank failed, keeping cosine order:`, error as Error)
              }
            }
            merged.push(...hitsInBase)
          } catch (error) {
            errors.push(`base ${base.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        merged.sort((a, b) => b.score - a.score)
        // 文档级去重（V2 kb_search 同语义）：同一文档（source）的多个 chunk 合并为
        // 一条引用——否则引用卡同文档重复多行、序号散乱（真机反馈"知识库的引用是
        // 乱的"）。正文按行去重后拼接（总量截 1200），模型仍拿到该文档的全部素材；
        // [n] 编号、meta entries、引用卡三者保持同序同集。
        const docOrder: string[] = []
        const docMap = new Map<string, { source: string; baseId: string; parts: string[] }>()
        for (const hit of merged) {
          const existing = docMap.get(hit.source)
          if (existing) {
            existing.parts.push(hit.pageContent)
          } else {
            docMap.set(hit.source, { source: hit.source, baseId: hit.baseId, parts: [hit.pageContent] })
            docOrder.push(hit.source)
          }
        }
        const documents = docOrder.map((source) => {
          const entry = docMap.get(source)
          if (entry === undefined) {
            return { source, baseId: source, content: '' }
          }
          const seen = new Set<string>()
          const lines: string[] = []
          for (const part of entry.parts) {
            for (const line of part.split('\n')) {
              const trimmed = line.trim()
              if (trimmed.length === 0 || seen.has(trimmed)) continue
              seen.add(trimmed)
              lines.push(line)
            }
          }
          return { source, baseId: entry.baseId, content: lines.join('\n').slice(0, 1200) }
        })
        const text =
          documents.length === 0
            ? [
                `No knowledge base results for "${query}".`,
                ...(errors.length > 0 ? [`Search errors: ${errors.join('; ')}`] : [])
              ].join('\n')
            : [
                `Knowledge base results for "${query}" (cited as [n]):`,
                // 条目形态与 web_search 完全一致（[n] 标题行 + 正文）——web 的 [n]
                // 被模型稳定回引，知识库此前带 "(source: ..., score: ...)" 元数据
                // 括注，[n] 易被模型当作注释而非引用标记。
                ...documents.map((doc, index) => `[${index + 1}] ${doc.source}\n${doc.content}`),
                ...(errors.length > 0 ? [`Partial search errors: ${errors.join('; ')}`] : []),
                'Citation rule: in your answer, place the matching [n] marker immediately after each statement these fragments support.'
              ].join('\n\n')
        logger.info(
          `knowledge_search: "${query}" over ${bases.length} base(s) -> ${merged.length} hits / ${documents.length} document(s)`
        )
        return {
          query,
          bases: bases.length,
          results: documents.length,
          entries: documents.map((doc) => ({ id: doc.baseId, source: doc.source, content: doc.content })),
          text
        }
      }
    })
  )
}
