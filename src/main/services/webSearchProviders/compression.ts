/**
 * 搜索结果 RAG 压缩（批次7，v0.3.2 验收反馈"尽早移植"）：上游
 * WebSearchService.compressWithSearchBase + utils/websearch.ts（selectReferences /
 * consolidateReferencesByUrl）的主进程适配版。
 *
 * fork 偏离（相对上游，均已注释）：
 * - 不建临时知识库（上游走 window.api.knowledgeBase IPC + embedjs）：fork 自建
 *   内核栈（chunker 滑窗 + EmbeddingClient 批量嵌入 + cosine 打分）进程内完成，
 *   无临时库生命周期。
 * - 失败降级：上游 RAG 失败清空全部结果（数据损失型），fork 降级直供原始结果。
 * - 同源片段按文档序拼接（上游按选中序=分数序，拼出的正文乱序难读）。
 */
import { loggerService } from '@logger'
import { lightRerank } from '@main/kernel/lightLlmModalities'

import { chunkText } from '../knowledge/chunker'
import type { EmbeddingModelRef } from '../knowledge/embeddings'
import { knowledgeService } from '../knowledge/KnowledgeService'
import type { WebSearchProviderResult } from './types'

const logger = loggerService.withContext('WebSearchCompression')

/** 上游 DEFAULT_WEBSEARCH_RAG_DOCUMENT_COUNT 同值。 */
const DEFAULT_RAG_DOCUMENT_COUNT = 1

interface ScoredChunk {
  url: string
  /** 文档内块序（拼接时按文档序还原）。 */
  order: number
  content: string
  score: number
}

/** 向量已归一化，点积即 cosine。 */
function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/**
 * 重排相（批次2 rerank 实装）：cosine 初筛序 → lightRerank 精排。候选规模 =
 * 全部去重块（重排端点按文档计费，块数即搜索结果量级，无需预截）。
 * 失败降级 cosine 序（如实记 warn，不静默吞）。
 */
async function rerankChunks(
  questions: string[],
  chunks: ScoredChunk[],
  rerank: { providerId: string; modelId: string } | undefined,
  signal?: AbortSignal
): Promise<ScoredChunk[]> {
  if (!rerank || chunks.length <= 1) return chunks
  try {
    // 多问题拼接为单一重排 query（与 cosine 的"任一问题最大分"同向：合并语义）。
    const result = await lightRerank(
      { providerId: rerank.providerId, modelId: rerank.modelId, query: questions.join('\n'), documents: chunks.map((c) => c.content) },
      signal
    )
    const reranked = result.results
      .map((entry) => ({ ...chunks[entry.index], score: entry.score }))
      .filter((entry) => entry.content !== undefined || entry.url !== undefined)
    logger.info(`RAG rerank: ${chunks.length} chunk(s) reranked`)
    return reranked
  } catch (error) {
    logger.warn('RAG rerank failed, falling back to cosine order:', error as Error)
    return chunks
  }
}

/**
 * RAG 压缩：结果正文分块 → 嵌入 → 按问题相关性打分排序去重 → 轮转选片
 *（每源均衡）→ 按 URL 合并回结果。嵌入模型缺失或任一步失败均降级直供原始结果。
 */
export async function compressWithRag(
  questions: string[],
  rawResults: WebSearchProviderResult[],
  config: { documentCount?: number; embedding?: EmbeddingModelRef; rerank?: { providerId: string; modelId: string } },
  signal?: AbortSignal
): Promise<WebSearchProviderResult[]> {
  const embedding = config.embedding
  if (!embedding || typeof embedding.providerId !== 'string' || typeof embedding.modelId !== 'string') {
    logger.warn('RAG compression requested without an embedding model, skipping compression')
    return rawResults
  }
  const documentCount = Math.max(1, Math.floor(config.documentCount ?? DEFAULT_RAG_DOCUMENT_COUNT))

  // 1. 分块（fork 知识库同款滑窗：1000/200 字符；空正文结果自然产出零块）
  const chunks: Array<{ url: string; order: number; content: string }> = []
  for (const result of rawResults) {
    const pieces = chunkText(result.content ?? '')
    pieces.forEach((piece, order) => chunks.push({ url: result.url, order, content: piece.content }))
  }
  if (chunks.length === 0) return rawResults

  try {
    // 2. 一次性批量嵌入（questions + 全部块；路由/密钥在 KnowledgeService 内解析）
    const vectors = await knowledgeService.embed(embedding, [...questions, ...chunks.map((c) => c.content)], signal)
    const questionVectors = vectors.slice(0, questions.length)
    const chunkVectors = vectors.slice(questions.length)

    // 3. 打分：块得分 = 与任一问题 cosine 的最大值（上游逐问检索合并排序的等效形式）
    const scored: ScoredChunk[] = chunks.map((chunk, index) => ({
      ...chunk,
      score: Math.max(...questionVectors.map((q) => dot(q, chunkVectors[index])))
    }))

    // 4. 按分数排序 + 文本去重（同上游 querySearchBase 的排序去重语义）
    scored.sort((a, b) => b.score - a.score)
    const seen = new Set<string>()
    const unique = scored.filter((chunk) => {
      if (seen.has(chunk.content)) return false
      seen.add(chunk.content)
      return true
    })

    // 4.5 重排相（批次2）：配置了 rerank 模型时 cosine 序 → 精排序（失败降级 cosine 序）
    const ranked = await rerankChunks(questions, unique, config.rerank, signal)

    // 5. 轮转选片（上游 selectReferences 同语义：按原始结果顺序轮询，每源均衡，
    //    总预算 = 结果条数 × documentCount）
    const maxRefs = rawResults.length * documentCount
    const selected = roundRobinSelect(rawResults, ranked, maxRefs)
    logger.info(`RAG compression: ${rawResults.length} result(s) -> ${selected.length} chunk(s) selected`)

    // 6. 按 URL 合并回结果（上游 consolidateReferencesByUrl 同语义；同源按文档序拼接）
    return consolidateByUrl(rawResults, selected)
  } catch (error) {
    logger.warn('RAG compression failed, falling back to raw results:', error as Error)
    return rawResults
  }
}

/** 上游 selectReferences 移植（类型收窄为 ScoredChunk；分数序已在外部排定）。 */
function roundRobinSelect(
  rawResults: WebSearchProviderResult[],
  references: ScoredChunk[],
  maxRefs: number
): ScoredChunk[] {
  if (maxRefs <= 0 || references.length === 0) return []

  const urlToIndex = new Map<string, number>()
  rawResults.forEach((result, index) => urlToIndex.set(result.url, index))

  const groupsByUrl = new Map<string, ScoredChunk[]>()
  for (const ref of references) {
    const group = groupsByUrl.get(ref.url)
    if (group) group.push(ref)
    else groupsByUrl.set(ref.url, [ref])
  }

  const availableUrls = Array.from(groupsByUrl.keys())
    .filter((url) => urlToIndex.has(url))
    .sort((a, b) => (urlToIndex.get(a) ?? 0) - (urlToIndex.get(b) ?? 0))
  if (availableUrls.length === 0) return []

  const selected: ScoredChunk[] = []
  let roundIndex = 0
  while (selected.length < maxRefs && availableUrls.length > 0) {
    const currentUrl = availableUrls[roundIndex]
    const group = groupsByUrl.get(currentUrl) ?? []
    if (group.length > 0) selected.push(group.shift() as ScoredChunk)
    if (group.length === 0) {
      availableUrls.splice(roundIndex, 1)
      if (roundIndex >= availableUrls.length) roundIndex = 0
    } else {
      roundIndex = (roundIndex + 1) % availableUrls.length
    }
  }
  return selected
}

/** 上游 consolidateReferencesByUrl 移植；同源片段按文档序（order）拼接。 */
function consolidateByUrl(
  rawResults: WebSearchProviderResult[],
  selected: ScoredChunk[],
  separator = '\n\n---\n\n'
): WebSearchProviderResult[] {
  const urlToOriginal = new Map(rawResults.map((result) => [result.url, result]))
  const groups = new Map<string, { original: WebSearchProviderResult; chunks: ScoredChunk[] }>()
  for (const chunk of selected) {
    const original = urlToOriginal.get(chunk.url)
    if (!original) continue
    const group = groups.get(chunk.url)
    if (group) group.chunks.push(chunk)
    else groups.set(chunk.url, { original, chunks: [chunk] })
  }
  return Array.from(groups.values(), (group) => ({
    title: group.original.title,
    url: group.original.url,
    content: group.chunks
      .sort((a, b) => a.order - b.order)
      .map((chunk) => chunk.content)
      .join(separator)
  }))
}
