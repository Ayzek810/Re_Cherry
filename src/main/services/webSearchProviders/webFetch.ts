import { loggerService } from '@logger'
import { readableContentService } from '@main/services/readableContent/ReadableContentService'
import { net } from 'electron'

import { searchService } from '../SearchService'
import type { WebSearchHttpOptions, WebSearchProviderResult } from './types'

const logger = loggerService.withContext('WebSearchFetch')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 src/renderer/src/utils/fetch.ts 的
 * noContent / isValidUrl / fetchWebContent；fetchWebContents 于 v0.4.3 删除——唯一
 * 消费者 processWebsearch 零调用方死码）：
 * - DOM 解析（DOM Parser）+ Readability + turndown 主进程不可用（turndown 的 Node DOM 依赖 jsdom
 *   为 devDep，打包闭包不含），正文抽取改为轻量 HTML→纯文本（去 script/style、剥标签、
 *   实体解码、空白折叠），title 取 <title>/og:title；format='html' 时仅剔除脚本样式。
 * - 抓取链（规则 c）：优先主进程直 fetch（30s 超时，与上游一致），非 abort 失败回退
 *   SearchService 隐藏窗口刮取；usingBrowser=true 直接走刮取。刮取窗口按 uid 用后即关
 *   （SearchService.closeSearchWindow 为本批次补齐）。
 * - **抓取用 net.fetch（v0.3.2 用户反馈修复）**：上游在渲染进程 fetch，走 Chromium
 *   网络栈（含系统代理）；批次2 用 Node undici 全局 fetch 不认系统代理——代理用户的
 *   结果页抓取全部超时/被重置（本地 bing 搜索"直接失败"的根因之一）。net.fetch 与
 *   渲染层行为对齐。signal 合并语义不变。
 * - 渲染层 searchService 桥（searchService.*）→ 直接函数调用 ../SearchService；nanoid → crypto.randomUUID。
 * - abort 语义与上游一致：AbortError 向上重抛，其余失败返回 noContent 占位结果。
 */

export const noContent = 'No content found'

export type WebContentFormat = 'markdown' | 'html' | 'text'

const FETCH_TIMEOUT_MS = 30000

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 上游渲染层 utils/error 的 isAbortError 同语义。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** 上游渲染层 utils/abortController 的 createAbortPromise 同语义：signal 中止则拒绝。 */
export function createAbortPromise<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  const makeAbortError = () => new DOMException('The operation was aborted.', 'AbortError')
  if (signal.aborted) {
    return Promise.reject(makeAbortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(makeAbortError())
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

/**
 * Validates if the string is a properly formatted URL
 */
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 用 SearchService 隐藏窗口刮取页面 HTML（uid 命名沿用上游 'search-window-' 前缀）。 */
async function scrapeInSearchWindow(url: string, signal?: AbortSignal): Promise<string> {
  const uid = `search-window-${crypto.randomUUID()}`
  try {
    const scrapePromise = searchService.openUrlInSearchWindow(uid, url)
    const promisesToRace: Array<Promise<string>> = [scrapePromise]
    if (signal) {
      promisesToRace.push(createAbortPromise(signal, scrapePromise))
    }
    return await Promise.race(promisesToRace)
  } finally {
    await searchService.closeSearchWindow(uid)
  }
}

function extractPageTitle(html: string, fallbackUrl: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (titleMatch && titleMatch[1].trim().length > 0) {
    return decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim())
  }
  const ogTitleMatch = /<meta[^>]+property=["']og:title["'][^>]*>/i.exec(html)
  if (ogTitleMatch) {
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(ogTitleMatch[0])
    if (content && (content[1] ?? content[2])) {
      return decodeEntities((content[1] ?? content[2]).trim())
    }
  }
  return fallbackUrl
}

/** 去 script/style 等无正文标签 → 块级标签断行 → 剥标签 → 实体解码 → 空白折叠。 */
function htmlToPlainText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  return decodeEntities(stripped.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

/** format='html' 的近似：仅剔除脚本样式与注释（上游返回 Readability 正文 HTML）。 */
function htmlToCleanHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code)
      }
      return match
    }
    return named[body.toLowerCase()] ?? match
  })
}

/**
 * v0.4 起 markdown/text 正文抽取改走 V2 Readability worker（readableContentService，
 * jsdom + @mozilla/readability + turndown），失败或空正文回退本文件遗留的轻量抽取
 * （V2 无回退路径，整批抛错——fork 保留三级抓取链的既有价值）。format='html' 无
 * 内核调用者，维持轻量剔除路径。
 */
async function buildContentResult(
  html: string,
  url: string,
  format: WebContentFormat,
  signal?: AbortSignal
): Promise<WebSearchProviderResult> {
  const title = extractPageTitle(html, url)
  switch (format) {
    case 'html': {
      const content = htmlToCleanHtml(html)
      return { title, url, content: content.length > 0 ? content : noContent }
    }
    case 'markdown':
    case 'text':
    default: {
      try {
        const article = await readableContentService.extractReadableMarkdown(html, { signal })
        const content = article.content.trim()
        if (content.length > 0) {
          return { title: article.title || title, url, content }
        }
        logger.warn(`readable content extraction produced empty body, falling back to plain text: ${url}`)
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }
        logger.warn(`readable content extraction failed, falling back to plain text: ${url}`, error as Error)
      }
      const content = htmlToPlainText(html)
      return { title, url, content: content.length > 0 ? content : noContent }
    }
  }
}

/**
 * 字符集解析与解码。undici/Electron 的 response.text() 恒按 UTF-8 解码——GBK/Big5
 * 中文页面整页乱码（V1 渲染层 fetch 按 header charset 解码，无此问题；v0.4 验收轮
 * "正文质量差"的主根因）。声明源优先级：Content-Type header → HTML meta 嗅探
 * （前 2KB 按 latin1 无损读字节再正则，charset 名恒为 ASCII）→ 缺省 utf-8。
 */
function sniffHtmlCharset(buffer: ArrayBuffer): string | undefined {
  const prefix = new TextDecoder('latin1').decode(buffer.slice(0, 2048))
  return /charset=["']?([\w-]+)/i.exec(prefix)?.[1]
}

function decodeBody(buffer: ArrayBuffer, contentType: string | null): string {
  const declared = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1] ?? sniffHtmlCharset(buffer) ?? 'utf-8'
  try {
    return new TextDecoder(declared.toLowerCase()).decode(buffer)
  } catch {
    logger.warn(`unsupported charset "${declared}", decoding as utf-8`)
    return new TextDecoder('utf-8').decode(buffer)
  }
}

/**
 * 主进程直抓（两级）：net.fetch（Chromium 栈，代理感知——上游渲染层 fetch 同栈）
 * 失败回退 Node 全局 fetch（undici，不走代理）。v0.3.2 真机事故：个别机器的
 * Chromium 网络服务失效（隐藏窗口与 net.fetch 同栈同灭，ERR_FAILED (-2)），而
 * Node 直连可用——两级取先成功者，各自落 debug/warn 日志。
 */
async function fetchHtmlDirect(url: string, signal?: AbortSignal): Promise<string> {
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const headers = { 'User-Agent': BROWSER_USER_AGENT }
  try {
    const response = await net.fetch(url, { headers, signal: timeoutSignal })
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`)
    }
    const html = decodeBody(await response.arrayBuffer(), response.headers.get('content-type'))
    if (html.length > 0) {
      return html
    }
    logger.warn(`net.fetch returned empty body, falling back to node fetch: ${url}`)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    logger.warn(`net.fetch failed, falling back to node fetch: ${url}`, error as Error)
  }
  const response = await fetch(url, { headers, signal: timeoutSignal })
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`)
  }
  return decodeBody(await response.arrayBuffer(), response.headers.get('content-type'))
}

export async function fetchWebContent(
  url: string,
  format: WebContentFormat = 'markdown',
  usingBrowser: boolean = false,
  httpOptions: WebSearchHttpOptions = {}
): Promise<WebSearchProviderResult> {
  try {
    // Validate URL before attempting to fetch
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL format: ${url}`)
    }
    const signal = httpOptions.signal

    let html: string
    if (usingBrowser) {
      html = await scrapeInSearchWindow(url, signal)
    } else {
      try {
        html = await fetchHtmlDirect(url, signal)
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }
        // 直抓两级都失败（反爬/网络等）→ 回退 SearchService 隐藏窗口刮取
        logger.warn(`direct fetch failed, fallback to search window scrape: ${url}`, error as Error)
        html = await scrapeInSearchWindow(url, signal)
      }
    }

    return await buildContentResult(html, url, format, signal)
  } catch (e: unknown) {
    if (isAbortError(e)) {
      throw e
    }

    logger.error(`Failed to fetch ${url}`, e as Error)
    return {
      title: url,
      url: url,
      content: noContent
    }
  }
}

/**
 * SERP 抓取（local-* 引擎专用，三级回退链）：隐藏窗口（上游形态，JS 渲染后取
 * DOM）→ net.fetch → Node 直连。v0.3.2 真机事故：隐藏窗口 loadURL 全量
 * ERR_FAILED (-2)（Chromium 网络服务失效的机器），而 Node 直连探针可用——
 * 上游单级窗口路径在这类机器上整体死路。每级失败落 warn，最终失败向上抛。
 */
export async function fetchSerpPage(url: string, signal: AbortSignal | undefined, engineId: string): Promise<string> {
  // 一级：隐藏窗口刮取（上游 SearchService 形态；页面 JS 渲染进 DOM 后取 outerHTML）
  const uid = `search-window-${crypto.randomUUID()}`
  try {
    const scrapePromise = searchService.openUrlInSearchWindow(uid, url)
    const promisesToRace: Array<Promise<string>> = [scrapePromise]
    if (signal) {
      promisesToRace.push(createAbortPromise(signal, scrapePromise))
    }
    const html = await Promise.race(promisesToRace)
    if (html !== undefined && html !== null && html.length > 0) {
      return html
    }
    logger.warn(`serp fetch (${engineId}): window path returned empty html, falling back`)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    logger.warn(`serp fetch (${engineId}): window path failed, falling back: ${url}`, error as Error)
  } finally {
    await searchService.closeSearchWindow(uid)
  }
  // 二级/三级：net.fetch（Chromium 栈，代理感知）→ Node 直连（undici，无代理）
  return await fetchHtmlDirect(url, signal)
}
