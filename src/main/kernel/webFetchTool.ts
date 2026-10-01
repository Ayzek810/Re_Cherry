/**
 * web_fetch 内核 builtin 工具（v0.4.6，roadmap「从V2寻找潜在的值得增加为工具的功能」）。
 *
 * V2 WebFetchTool 同构物：模型拿已知 URL（用户给的或 web_search 命中的）取可读正文。
 * fork 后端已就绪——services/webSearchProviders/webFetch.ts 的三级抓取链（net.fetch →
 * Node 直连 → 隐藏窗口刮取；charset 嗅探；jsdom+Readability+ turndown worker）即执行体，
 * 本文件只是工具缝。挂载门随 web_search（messageThunk 的 webSearchActive），执行不依赖
 * 搜索提供商。
 *
 * 体积治理：原生模式下内核无工具输出截断（dsh-output-retention 未接线），本工具自带
 * 分页——每页默认 20000 字符（截断时给 truncated + totalChars，模型以同 URL + offset
 * 续读）。结果并入 web_search 的全局 [n] 编号（bumpTurnResultOffset）与统一引用卡
 * （presentationMeta kind:'web-search'），同轮 web_search + web_fetch 编号连续同源。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { fetchWebContent, isAbortError, noContent } from '../services/webSearchProviders/webFetch'
import { webSearchService } from '../services/WebSearchService'

const logger = loggerService.withContext('WebFetchTool')

export const name = 'tool-web-fetch'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const PAGE_CHARS = 20000
const MAX_URLS = 5

const DESCRIPTION =
  'Fetch the readable content of one or more known web page URLs. Use it when you already have specific URLs ' +
  'from the user, from earlier answers, or from web_search results. Do not use it with only a topic or a ' +
  'question; run web_search first. Send at most 5 URLs per call. Each page returns up to 20000 characters; ' +
  'when a result reports truncated, call again with the same URL and the returned nextOffset. Cite each page ' +
  'inline as [n] right after the statements it supports.'

interface FetchedEntry {
  index: number
  title: string
  url: string
  content: string
  truncated: boolean
  totalChars: number
  nextOffset?: number
}

/** 解析模型入参为去重 http(s) URL 清单；非法项具名报错（不静默丢弃——失败不伪装成空）。 */
export function parseUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error('web_fetch: urls must be an array of strings')
  }
  const seen = new Set<string>()
  const urls: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new Error('web_fetch: urls must be an array of strings')
    }
    const candidate = item.trim()
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error(`web_fetch: invalid URL "${candidate}"`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`web_fetch: only http(s) URLs are supported, got "${candidate}"`)
    }
    if (seen.has(candidate)) continue
    seen.add(candidate)
    urls.push(candidate)
  }
  if (urls.length === 0) {
    throw new Error('web_fetch: empty url list')
  }
  if (urls.length > MAX_URLS) {
    throw new Error(`web_fetch: at most ${MAX_URLS} URLs per call`)
  }
  return urls
}

/** 单页切片：offset 越界回 0（续读参数损坏时从头给，不报错不裁空）。 */
export function slicePage(content: string, offset: number): { text: string; truncated: boolean; nextOffset?: number } {
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  if (start >= content.length) {
    return { text: '', truncated: false, nextOffset: undefined }
  }
  const text = content.slice(start, start + PAGE_CHARS)
  const truncated = start + text.length < content.length
  return {
    text,
    truncated,
    ...(truncated ? { nextOffset: start + text.length } : {})
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'web_fetch',
      description: DESCRIPTION,
      parameters: {
        urls: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'The page URLs to fetch. At most 5 per call.'
        },
        offset: {
          type: 'number',
          description:
            'Character offset to continue a truncated page from. Omit for first reads; pass the returned nextOffset to continue.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
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
                  content: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  totalChars: { type: 'number', required: true },
                  nextOffset: { type: 'number' }
                }
              }
            },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        // 统一引用机制：与 web_search 同形（kind:'web-search'），取回页并入同一引用卡，
        // [n] 编号经 bumpTurnResultOffset 与搜索结果接续同源。
        presentationMeta: (_args, value) => ({
          kind: 'web-search',
          results: value.entries ?? []
        })
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const urls = parseUrls(args.urls)
        const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0
        const topicId = exec.agent?.session?.id
        const entries: FetchedEntry[] = []
        for (const url of urls) {
          if (exec.signal.aborted) break
          try {
            // format=markdown：jsdom+Readability+ turndown 走 worker，与 webSearch 压缩同链。
            const result = await fetchWebContent(url, 'markdown', false, { signal: exec.signal })
            const content = result.content === noContent ? '' : result.content
            const page = slicePage(content, rawOffset)
            entries.push({
              index: 0,
              title: result.title,
              url,
              content: page.text,
              truncated: page.truncated,
              totalChars: content.length,
              ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset })
            })
          } catch (error) {
            if (isAbortError(error)) throw error
            // 单页失败不整批报错：具名失败条目照常进列表（失败不伪装成空，但也不连坐）。
            logger.warn(`web_fetch: page failed "${url}"`, error as Error)
            entries.push({
              index: 0,
              title: url,
              url,
              content: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
              truncated: false,
              totalChars: 0
            })
          }
        }
        // 同轮全局 [n] 编号（web_search 同机制）：引用卡与正文编号连续同源。
        const offset = topicId === undefined ? 0 : webSearchService.bumpTurnResultOffset(topicId, entries.length)
        entries.forEach((entry, i) => {
          entry.index = offset + i + 1
        })
        const text =
          entries.length === 0
            ? 'No pages were fetched (empty request).'
            : [
                'Fetched pages (cited as [n]):',
                ...entries.map((e) =>
                  [
                    `[${e.index}] ${e.title}`,
                    e.url,
                    e.content,
                    e.truncated
                      ? `(truncated at ${e.content.length} of ${e.totalChars} chars; call again with offset ${e.nextOffset} for the next part)`
                      : ''
                  ]
                    .filter((line) => line.length > 0)
                    .join('\n')
                ),
                'Citation rule: in your answer, place the matching [n] marker immediately after each statement these pages support.'
              ].join('\n\n')
        logger.info(`web_fetch: ${urls.length} url(s) -> ${entries.map((e) => `${e.totalChars}ch`).join(', ')}`)
        return {
          results: entries.length,
          entries: entries.map(({ title, url, content, truncated, totalChars, nextOffset }) => ({
            title,
            url,
            content,
            truncated,
            totalChars,
            ...(nextOffset === undefined ? {} : { nextOffset })
          })),
          text
        }
      }
    })
  )
}
