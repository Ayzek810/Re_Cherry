import { loggerService } from '@logger'
import type { KernelWebSearchProviderConfig } from '@shared/config/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import type { WebSearchHttpOptions, WebSearchProviderResponse, WebSearchRuntimeState } from './types'

const logger = loggerService.withContext('ExaMcpProvider')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游 ExaMcpProvider.ts）：
 * - 上游本就是裸 fetch（MCP jsonrpc tools/call → web_search_exa），请求构造、
 *   25s 超时 + AbortSignal.any 合并外部信号、defaultHeaders + SSE accept 头原样保留。
 * - SSE 解析改为主进程 fetch body 流手工按行解析（data: 帧切分，规则 d）：上游是
 *   response.text() 全量再按行找 data: 帧；流式实现语义等价——命中首个带结果的
 *   data: 帧即取消流返回，流结束仍无帧则回退整包 JSON 解析（上游非 SSE 兜底）。
 * - parsetextChunk（Title/Published/URL/Text|Highlights 行块解析）原样移植。
 */
interface McpSearchRequest {
  jsonrpc: string
  id: number
  method: string
  params: {
    name: string
    arguments: {
      query: string
      numResults?: number
      livecrawl?: 'fallback' | 'preferred'
      type?: 'auto' | 'fast' | 'deep'
    }
  }
}

interface McpSearchResponse {
  jsonrpc: string
  result: {
    content: Array<{ type: string; text: string }>
  }
}

interface ExaSearchResult {
  title?: string
  url?: string
  text?: string
  publishedDate?: string
  author?: string
}

interface ExaSearchResults {
  results?: ExaSearchResult[]
  autopromptString?: string
}

const DEFAULT_API_HOST = 'https://mcp.exa.ai/mcp'
const DEFAULT_NUM_RESULTS = 8
const REQUEST_TIMEOUT_MS = 25000

export default class ExaMcpProvider extends BaseWebSearchProvider {
  constructor(provider: KernelWebSearchProviderConfig) {
    super(provider)
    if (!this.apiHost) {
      this.apiHost = DEFAULT_API_HOST
    }
  }

  public async search(
    query: string,
    websearch: WebSearchRuntimeState,
    httpOptions?: WebSearchHttpOptions
  ): Promise<WebSearchProviderResponse> {
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty')
      }

      const searchRequest: McpSearchRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query,
            type: 'auto',
            numResults: websearch.maxResults || DEFAULT_NUM_RESULTS,
            livecrawl: 'fallback'
          }
        }
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const response = await fetch(this.apiHost!, {
          method: 'POST',
          headers: {
            ...this.defaultHeaders(),
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: JSON.stringify(searchRequest),
          signal: httpOptions?.signal ? AbortSignal.any([controller.signal, httpOptions.signal]) : controller.signal
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Search error (${response.status}): ${errorText}`)
        }

        const searchResults = await this.parseResponseStream(response)

        return {
          query: searchResults.autopromptString || query,
          results: (searchResults.results || []).slice(0, websearch.maxResults).map((result) => ({
            title: result.title || 'No title',
            content: result.text || '',
            url: result.url || ''
          }))
        }
      } catch (error) {
        clearTimeout(timeoutId)

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Search request timed out')
        }

        throw error
      }
    } catch (error) {
      logger.error('Exa MCP search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private parsetextChunk(raw: string): ExaSearchResult[] {
    const items: ExaSearchResult[] = []
    for (const chunk of raw.split('\n\n')) {
      // 3. Parse the labeled lines inside the text block
      const lines = chunk.split('\n')
      let title = ''
      let publishedDate = ''
      let url = ''
      let fullText = ''

      // We'll capture everything after the first "Text:" as the article text
      let textStartIndex = -1

      lines.forEach((line, idx) => {
        if (line.startsWith('Title:')) {
          title = line.replace(/^Title:\s*/, '')
        } else if (line.startsWith('Published:')) {
          publishedDate = line.replace(/^Published:\s*/, '')
        } else if (line.startsWith('URL:')) {
          url = line.replace(/^URL:\s*/, '')
        } else if ((line.startsWith('Text:') || line.startsWith('Highlights:')) && textStartIndex === -1) {
          textStartIndex = idx
          fullText = line.replace(/^(?:Text|Highlights):\s*/, '')
        }
      })
      if (textStartIndex !== -1) {
        const rest = lines.slice(textStartIndex + 1).join('\n')
        if (rest.trim().length > 0) {
          fullText = (fullText ? fullText + '\n' : '') + rest
        }
      }

      // If we at least got a title or URL, treat it as a valid article
      if (title || url || fullText) {
        items.push({
          title,
          publishedDate,
          url,
          text: fullText
        })
      }
    }
    return items
  }

  /** 单个 SSE data: 帧的解析（与上游 parseResponse 的行处理一致）。 */
  private parseDataLine(line: string): ExaSearchResults | undefined {
    if (!line.startsWith('data: ')) {
      return undefined
    }
    try {
      const data: McpSearchResponse = JSON.parse(line.substring(6))
      if (data.result?.content?.[0]?.text) {
        // The text content contains stringified JSON with the actual results
        return { results: this.parsetextChunk(data.result.content[0].text) }
      }
    } catch {
      // Continue to next line if parsing fails
      logger.warn('Failed to parse SSE line:', { line })
    }
    return undefined
  }

  /**
   * SSE 流式解析：fetch body 按行切 data: 帧，命中首个结果帧即取消流返回；
   * 流结束仍无帧 → 回退整包 JSON 解析（上游 parseResponse 的非 SSE 兜底）。
   */
  private async parseResponseStream(response: Response): Promise<ExaSearchResults> {
    const reader = response.body?.getReader()
    if (!reader) {
      logger.warn('Response body is not readable, returning empty results')
      return { results: [] }
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        const chunk = decoder.decode(value, { stream: true })
        fullText += chunk
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const parsed = this.parseDataLine(line)
          if (parsed) {
            return parsed
          }
        }
      }
      // 流末尾未换行的残余行
      if (buffer.length > 0) {
        const parsed = this.parseDataLine(buffer)
        if (parsed) {
          return parsed
        }
      }
    } finally {
      // 提前命中时取消剩余流；流已读完时为无害空操作
      void reader.cancel().catch(() => {})
    }

    // Try parsing as direct JSON response (non-SSE)
    try {
      const data: McpSearchResponse = JSON.parse(fullText)
      if (data.result?.content?.[0]?.text) {
        return { results: this.parsetextChunk(data.result.content[0].text) }
      }
    } catch {
      // Ignore parsing errors
      logger.warn('Failed to parse direct JSON response:', { length: fullText.length })
    }

    return { results: [] }
  }
}
