/**
 * knowledge_read 内核 builtin 工具（v0.4.6）。
 *
 * V2 kb_read 同构物：knowledge_search 命中只给片段（且文档级合并截 1200 字符），
 * 模型需要整读命中文档或在其内部精确查找。fork 侧文档全文 = 摄取 chunk 的有序拼接
 * （BaseVectorStore.readByUniqueId），拼接时做 chunk overlap 去重（chunker 硬切段带
 * overlap 尾部，段落合并段不带）。
 *
 * 双模式（V2 同语义）：省略 pattern = 整读（带 offset 分页——原生模式内核无输出截断，
 * 工具自带每页 20000 字符）；传 pattern = 文档内 grep（正则、行号 + 片段，默认 50 上限
 * 200）。执行侧防线：baseId 必须在本轮登记（turnBases），与 knowledge_search 同型。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { knowledgeService } from '../services/knowledge/KnowledgeService'

const logger = loggerService.withContext('KnowledgeReadTool')

export const name = 'tool-knowledge-read'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const PAGE_CHARS = 20000
const DEFAULT_MAX_MATCHES = 50
const MAX_MATCHES_CAP = 200

const DESCRIPTION =
  'Read one document from an attached knowledge base in full, or grep inside it. Use it after knowledge_search ' +
  'when a fragment is not enough: pass the baseId and the document id exactly as a knowledge_search result ' +
  'reports them. Omit pattern to read the whole text (long texts come back in pages; continue with nextOffset). ' +
  'Pass pattern (a regular expression) to locate exact text instead; results carry line numbers and snippets.'

/** chunk 序列 → 摄取全文：相邻同源 chunk 做后缀/前缀重叠去重（窗口上限 = 库的 chunkOverlap）。 */
export function concatChunks(
  chunks: Array<{ content: string; source: string }>,
  maxOverlap: number
): string {
  let text = ''
  let previousSource: string | undefined
  for (const chunk of chunks) {
    const content = chunk.content
    if (text.length === 0) {
      text = content
      previousSource = chunk.source
      continue
    }
    let overlap = 0
    if (previousSource === chunk.source && maxOverlap > 0) {
      const limit = Math.min(maxOverlap, text.length, content.length)
      for (let candidate = limit; candidate > 0; candidate--) {
        if (text.endsWith(content.slice(0, candidate))) {
          overlap = candidate
          break
        }
      }
    }
    text += (overlap > 0 ? '' : '\n\n') + content.slice(overlap)
    previousSource = chunk.source
  }
  return text
}

/** 整读分页切片（web_fetch 同语义：offset 越界回空页，不报错）。 */
export function slicePage(text: string, offset: number): { page: string; truncated: boolean; nextOffset?: number } {
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  if (start >= text.length) {
    return { page: '', truncated: false }
  }
  const page = text.slice(start, start + PAGE_CHARS)
  const truncated = start + page.length < text.length
  return { page, truncated, ...(truncated ? { nextOffset: start + page.length } : {}) }
}

export interface GrepMatch {
  line: number
  charStart: number
  snippet: string
}

/** 文档内 grep：行号 + 片段；totalMatches 恒为全量计数，matches 截 maxMatches。 */
export function grepDocument(
  text: string,
  pattern: string,
  ignoreCase: boolean,
  maxMatches: number
): { totalMatches: number; matches: GrepMatch[] } {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g')
  } catch (error) {
    throw new Error(`knowledge_read: invalid pattern — ${error instanceof Error ? error.message : String(error)}`)
  }
  const matches: GrepMatch[] = []
  let charStart = 0
  let lineNumber = 0
  let total = 0
  for (const line of text.split('\n')) {
    lineNumber++
    regex.lastIndex = 0
    if (regex.test(line)) {
      total++
      if (matches.length < maxMatches) {
        matches.push({ line: lineNumber, charStart, snippet: line.slice(0, 500) })
      }
    }
    charStart += line.length + 1
  }
  return { totalMatches: total, matches }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'knowledge_read',
      description: DESCRIPTION,
      parameters: {
        baseId: {
          type: 'string',
          required: true,
          description: 'The knowledge base id, exactly as a knowledge_search result reports it.'
        },
        document: {
          type: 'string',
          required: true,
          description: 'The document id, exactly as a knowledge_search result reports it.'
        },
        source: {
          type: 'string',
          description:
            'Optional source name for multi-document entries (a sitemap or directory upload holds several). Omit for normal documents.'
        },
        offset: {
          type: 'number',
          description: 'Character offset to continue a truncated read from. Omit for first reads.'
        },
        pattern: {
          type: 'string',
          description: 'Regular expression to grep inside the document instead of reading it.'
        },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive grep. Omit for case-sensitive.' },
        maxMatches: {
          type: 'number',
          description: 'Maximum matches to return (default 50, cap 200). The total count is always reported.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            document: { type: 'string', required: true },
            totalChars: { type: 'number', required: true },
            truncated: { type: 'boolean', required: true },
            nextOffset: { type: 'number' },
            totalMatches: { type: 'number' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'number', required: true },
                  charStart: { type: 'number', required: true },
                  snippet: { type: 'string', required: true }
                }
              }
            },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const baseId = String(args.baseId ?? '').trim()
        const document = String(args.document ?? '').trim()
        if (baseId.length === 0 || document.length === 0) {
          throw new Error('knowledge_read: baseId and document are required')
        }
        const topicId = exec.agent?.session?.id
        if (topicId === undefined) {
          throw new Error('knowledge_read: no active conversation turn')
        }
        const chunks = await knowledgeService.readBaseDocument(topicId, baseId, document)
        const source = typeof args.source === 'string' && args.source.length > 0 ? args.source : undefined
        const selected = source === undefined ? chunks : chunks.filter((chunk) => chunk.source === source)
        if (selected.length === 0) {
          const known = [...new Set(chunks.map((chunk) => `"${chunk.source}"`))].join(', ')
          throw new Error(
            `knowledge_read: source "${source}" not found in document "${document}" (available sources: ${known})`
          )
        }
        const bases = knowledgeService.getTurnBases(topicId) ?? []
        const base = bases.find((candidate) => candidate.id === baseId)
        const maxOverlap = Math.max(0, Math.floor(base?.chunkOverlap ?? 0))
        const fullText = concatChunks(selected, maxOverlap)
        if (fullText.length === 0) {
          // 空抽取在摄取侧已过滤（空文档不入库），这里按不可达防御返回中性提示。
          return {
            document,
            totalChars: 0,
            truncated: false,
            text: 'The stored document has no text content.'
          }
        }
        if (typeof args.pattern === 'string' && args.pattern.length > 0) {
          const ignoreCase = args.ignoreCase === true
          const requested = typeof args.maxMatches === 'number' && Number.isFinite(args.maxMatches)
            ? Math.trunc(args.maxMatches)
            : DEFAULT_MAX_MATCHES
          const maxMatches = Math.min(Math.max(1, requested), MAX_MATCHES_CAP)
          const { totalMatches, matches } = grepDocument(fullText, args.pattern, ignoreCase, maxMatches)
          const text =
            totalMatches === 0
              ? `No matches for "${args.pattern}" in document "${document}" (${fullText.length} chars).`
              : [
                  `Grep "${args.pattern}" in "${document}" (${totalMatches} match(es) total${totalMatches > matches.length ? `, showing first ${matches.length}` : ''}):`,
                  ...matches.map((match) => `L${match.line} @${match.charStart}: ${match.snippet}`)
                ].join('\n')
          logger.info(`knowledge_read: grep "${args.pattern}" in ${baseId}/${document} -> ${totalMatches} match(es)`)
          return {
            document,
            totalChars: fullText.length,
            truncated: totalMatches > matches.length,
            totalMatches,
            matches,
            text
          }
        }
        const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0
        const { page, truncated, nextOffset } = slicePage(fullText, offset)
        logger.info(`knowledge_read: ${baseId}/${document} -> ${fullText.length} chars (page ${page.length})`)
        return {
          document,
          totalChars: fullText.length,
          truncated,
          ...(nextOffset === undefined ? {} : { nextOffset }),
          text: page.length === 0 ? `Offset ${offset} is past the end of the document (${fullText.length} chars).` : page
        }
      }
    })
  )
}
