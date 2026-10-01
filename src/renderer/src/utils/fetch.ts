import { loggerService } from '@logger'
import { Readability } from '@mozilla/readability'
import { nanoid } from '@reduxjs/toolkit'
import type { WebSearchProviderResult } from '@renderer/types'
import { createAbortPromise } from '@renderer/utils/abortController'
import { isAbortError } from '@renderer/utils/error'
import TurndownService from 'turndown'

const logger = loggerService.withContext('Utils:fetch')

const turndownService = new TurndownService()
export const noContent = 'No content found'

type ResponseFormat = 'markdown' | 'html' | 'text'

/**
 * Validates if the string is a properly formatted URL
 */
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (e) {
    return false
  }
}

/** 批量抓取：`fetchWebContent` 在 r2-75 之后对失败一律 reject，这里保持"整体失败即抛"
 *  的语义。此前它把单条失败折成 `{ title: 'Error', content: 'No content found' }` 的
 *  **成功**结果——失败被伪装成"页面没有正文"，正是家规禁止的形态。
 *  （无生产消费者；消费者要求"部分成功也算结果"时，应改为返回 `{ results, failures }`。） */
export async function fetchWebContents(
  urls: string[],
  format: ResponseFormat = 'markdown',
  usingBrowser: boolean = false,
  httpOptions: RequestInit = {}
): Promise<WebSearchProviderResult[]> {
  return Promise.all(urls.map((url) => fetchWebContent(url, format, usingBrowser, httpOptions)))
}

export async function fetchWebContent(
  url: string,
  format: ResponseFormat = 'markdown',
  usingBrowser: boolean = false,
  httpOptions: RequestInit = {}
): Promise<WebSearchProviderResult> {
  try {
    // Validate URL before attempting to fetch
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL format: ${url}`)
    }

    let html: string
    if (usingBrowser) {
      const windowApiPromise = window.api.searchService.openUrlInSearchWindow(`search-window-${nanoid()}`, url)

      const promisesToRace: [Promise<string>] = [windowApiPromise]

      if (httpOptions?.signal) {
        const signal = httpOptions.signal
        const abortPromise = createAbortPromise(signal, windowApiPromise)
        promisesToRace.push(abortPromise)
      }

      html = await Promise.race(promisesToRace)
    } else {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        ...httpOptions,
        signal: httpOptions?.signal
          ? AbortSignal.any([httpOptions.signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000)
      })
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`)
      }
      html = await response.text()
    }

    // clearTimeout(timeoutId) // Clear the timeout if fetch completes successfully
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const article = new Readability(doc).parse()
    // Logger.log('Parsed article:', article)

    switch (format) {
      case 'markdown': {
        const markdown = turndownService.turndown(article?.content || '')
        return {
          title: article?.title || url,
          url: url,
          content: markdown || noContent
        }
      }
      case 'html':
        return {
          title: article?.title || url,
          url: url,
          content: article?.content || noContent
        }
      case 'text':
        return {
          title: article?.title || url,
          url: url,
          content: article?.textContent || noContent
        }
    }
  } catch (e: unknown) {
    if (isAbortError(e)) {
      throw e
    }

    // r2-75：非取消的抓取失败（403/超时/网络/DOMParser 异常）**必须 reject**。
    // 此前它返回一个 content = noContent 的"成功"结果，调用方（引用卡摘要）把它当正文
    // 渲染，于是"抓取失败"与"页面确实没有正文"在界面上不可区分——家规明写「失败必须
    // 拒绝，绝不渲染部分或伪造结果」。日志提到 warn：渲染层 debug/info 不落盘，
    // 这里要留可取证的一行。
    logger.warn(`Failed to fetch ${url}`, e as Error)
    throw e
  }
}

/**
 * Check if a URL is an X/Twitter post URL
 */
export function isXPostUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    return (host === 'x.com' || host === 'twitter.com') && /\/status\/\d+/.test(parsed.pathname)
  } catch {
    return false
  }
}

/**
 * Fetch tweet content via X oEmbed API
 * @see https://docs.x.com/x-for-websites/oembed-api
 */
export async function fetchXOEmbed(url: string): Promise<{ author: string; text: string } | null> {
  try {
    const oembedUrl = `https://publish.x.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=1`
    const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) return null
    const data = await response.json()
    // Extract text from html: <blockquote ...><p ...>text</p>&mdash; author ...</blockquote>
    const parser = new DOMParser()
    const doc = parser.parseFromString(data.html || '', 'text/html')
    const paragraphs = doc.querySelectorAll('blockquote p')
    const text = Array.from(paragraphs)
      .map((p) => p.textContent)
      .join('\n')
    return {
      author: data.author_name || '',
      text: text || ''
    }
  } catch (e) {
    logger.warn('Failed to fetch X oEmbed', e as Error)
    return null
  }
}

/**
 * 取 url 的最终跳转地址。
 *
 * r2-91：失败**不再伪装成「没有重定向」**。旧实现 `catch { return url }` 让「取重定向失败」
 * 与「确实没有重定向」在类型与调用方语义上完全同形（都是原 url），失败被折成正常结果。
 * 现在非取消的失败一律 rethrow（`isAbortError` 直通，调用方能区分用户取消），日志用 `warn`
 *（渲染层 debug/info 不落盘，warn 可取证）。
 *
 * 注意：本导出当前**无生产调用者**（全仓仅 `utils/__tests__/fetch.test.ts`）。
 */
export async function fetchRedirectUrl(url: string) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    return response.url
  } catch (e) {
    if (isAbortError(e)) {
      throw e
    }
    logger.warn(`Failed to fetch redirect url for ${url}`, e as Error)
    throw e
  }
}
