/// <reference lib="webworker" />

import { loggerService } from '@logger'
import { LRUCache } from 'lru-cache'
import type { HighlighterCore, LanguageRegistration, SpecialLanguage, ThemedToken } from 'shiki/core'

// 注意保持 ShikiStreamTokenizer 依赖简单，避免打包出问题
import type { ShikiStreamTokenizerOptions } from '../services/ShikiStreamTokenizer'
import { ShikiStreamTokenizer } from '../services/ShikiStreamTokenizer'

const logger = loggerService.initWindowSource('Worker').withContext('ShikiStream')

// Worker 消息类型
type WorkerMessageType = 'init' | 'highlight' | 'cleanup' | 'dispose'

interface WorkerRequest {
  id: number
  type: WorkerMessageType
  callerId?: string
  chunk?: string
  language?: string
  theme?: string
  languages?: string[]
  themes?: string[]
}

interface WorkerResponse {
  id: number
  type: string
  result?: any
  error?: string
}

interface HighlightChunkResult {
  lines: ThemedToken[][]
  recall: number
}

// ---------------------------------------------------------------------------
// 语法/主题资产改由主线程下发（v1 二轮性能审计 p2-04）
//
// 此前本 worker 自己 `await import('shiki')` 取 `createHighlighter` / `bundledLanguages` /
// `bundledThemes`。worker 是**一份独立的 rollup 模块图**：它 import shiki 会让整张
// `bundledLanguages` 语言表（286 个语言 chunk，实测 7.34 MB）在产物里再编译一份——主图
// `utils/shiki.ts` 已有一份 ⇒ 每个语法两份，全产物重复 **4.15 MB**。
//
// 现在 worker 只保留 shiki 的**核心**（`shiki/core` 的类型 + `createHighlighterCore` +
// js 引擎），语法/主题的注册数据经 `postMessage` 从主线程取：注册数据是 JSON，可结构化克隆，
// 主线程侧由 `resolveLanguageRegistrations` / `resolveThemeRegistrations` 解析。
// 这样产物里不再出现 worker 侧语言表，双份随之消失。
// ---------------------------------------------------------------------------

// 后两个是 worker → 主线程的**资产协议**消息（p2-04），不属于 `WorkerRequest`：
// worker 不再自带 shiki 语言/主题表，改为按需向主线程索取注册数据。
type WorkerInboundMessage = WorkerRequest | { id: number; type: 'assets-result'; result?: unknown[]; error?: string }

/**
 * worker → 主线程的资产消息用**独立 id 空间**。
 *
 * 关键：主线程的 `pendingRequests` 用 `init`/`highlight`/`cleanup`/`dispose` 的请求 id 索引。
 * 若资产的 id 与某个在飞命令的 id 撞上，主线程会把回包认成那条命令的应答 ⇒ 命令永久悬挂
 * （表现是流式高亮卡死）。这里给资产 id 加高位前缀（`0xA55E0000`）保证两个命名空间不相交
 * （命令 id 从 0 起、单窗口内不会走到 28 亿）。
 */
const ASSET_ID_BASE = 0xa55e0000
let assetRequestId = 0
const pendingAssetRequests = new Map<number, { resolve: (value: unknown[]) => void; reject: (error: Error) => void }>()

/** 资产请求超时（毫秒）：主线程若已消失，不能让流式高亮永久挂在 await 上。 */
const ASSET_REQUEST_TIMEOUT = 10_000

/** 向主线程索取一份资产（语言或主题的注册数据）。 */
function requestAsset(kind: 'language' | 'theme', name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const id = ASSET_ID_BASE + assetRequestId++
    const timer = setTimeout(() => {
      if (!pendingAssetRequests.delete(id)) return
      reject(new Error(`Asset request timed out: ${kind} ${name}`))
    }, ASSET_REQUEST_TIMEOUT)
    pendingAssetRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    self.postMessage({ id, type: 'assets-request', kind, name })
  })
}

/** 主线程资产回包（由 `self.onmessage` 分派）。 */
function settleAssetRequest(id: number, result: unknown[] | undefined, error: string | undefined): void {
  const pending = pendingAssetRequests.get(id)
  if (!pending) return
  pendingAssetRequests.delete(id)
  if (error !== undefined) {
    pending.reject(new Error(error))
  } else {
    pending.resolve(result ?? [])
  }
}

// Worker 全局变量
let highlighter: HighlighterCore | null = null

// 保存以 callerId-language-theme 为键的 tokenizer map
const tokenizerMap = new LRUCache<string, ShikiStreamTokenizer>({
  max: 100, // 最大缓存数量
  ttl: 1000 * 60 * 15, // 15分钟过期时间
  updateAgeOnGet: true,
  dispose: (value) => {
    if (value) value.clear()
  }
})

// 初始化高亮器
async function initHighlighter(_themes: string[], _languages: string[]): Promise<void> {
  // p2-04：拿 `shiki/core`（核心 + 构造器，**不带**任何语言/主题表）与 js 引擎，注册数据由主线程
  // 按需下发。引擎与主图 `shiki/bundle/web` 用的是同一个（`@shikijs/engine-javascript`），
  // token 输出与旧的 `createHighlighter` 一致；区别只是 worker 图里不再出现语言表。
  // 入口写成 `shiki/core` + `shiki/dist/engine-javascript.mjs`：后者是 `shiki` 的公开
  // `./dist/*` 导出面（`@shikijs/engine-javascript` 只是它的传递依赖，直接 import 会 TS2307）。
  const [{ createBundledHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/dist/engine-javascript.mjs')
  ])
  // `langs`/`themes` 故意留空：worker 不打包任何语言表，所有语法/主题都经 `requestAsset`
  // 从主线程拿注册数据（`loadLanguage(registrations)` / `loadTheme(...)`）。
  // 用 `createBundledHighlighter`（而不是 `createHighlighterCore`）是为了保留 `loadLanguage('text')`
  // 这类**特殊语言名**的支持：与旧的 `createHighlighter` 同一实现路径，故 token 行为不变。
  const createHighlighter = createBundledHighlighter<string, string>({
    langs: {},
    themes: {},
    engine: () => createJavaScriptRegexEngine()
  })
  highlighter = await createHighlighter({ langs: [], themes: [] })
}

// 确保语言和主题已加载
async function ensureLanguageAndThemeLoaded(
  language: string,
  theme: string
): Promise<{ actualLanguage: string; actualTheme: string }> {
  if (!highlighter) {
    throw new Error('Highlighter not initialized')
  }

  let actualLanguage = language
  let actualTheme = theme

  // 加载语言
  if (!highlighter.getLoadedLanguages().includes(language)) {
    try {
      if (['text', 'ansi'].includes(language)) {
        await highlighter.loadLanguage(language as SpecialLanguage)
      } else {
        const registrations = await requestAsset('language', language)
        if (registrations.length === 0) {
          throw new Error(`Unknown language: ${language}`)
        }
        await highlighter.loadLanguage(registrations as unknown as LanguageRegistration[])
      }
    } catch (error) {
      // 回退到 text
      await highlighter.loadLanguage('text')
      actualLanguage = 'text'
    }
  }

  // 加载主题
  if (!highlighter.getLoadedThemes().includes(theme)) {
    try {
      const registrations = await requestAsset('theme', theme)
      if (registrations.length === 0) {
        throw new Error(`Unknown theme: ${theme}`)
      }
      await highlighter.loadTheme(registrations as unknown as Parameters<HighlighterCore['loadTheme']>[0])
    } catch (error) {
      // 回退到 one-light
      logger.debug(`Worker: Failed to load theme '${theme}', falling back to 'one-light':`, error as Error)
      const fallback = await requestAsset('theme', 'one-light')
      await highlighter.loadTheme(fallback as unknown as Parameters<HighlighterCore['loadTheme']>[0])
      actualTheme = 'one-light'
    }
  }

  return { actualLanguage, actualTheme }
}

// 获取或创建 tokenizer
async function getStreamTokenizer(callerId: string, language: string, theme: string): Promise<ShikiStreamTokenizer> {
  // 创建复合键
  const cacheKey = `${callerId}-${language}-${theme}`

  // 如果已存在，直接返回
  if (tokenizerMap.has(cacheKey)) {
    return tokenizerMap.get(cacheKey)!
  }

  if (!highlighter) {
    throw new Error('Highlighter not initialized')
  }

  // 确保语言和主题已加载
  const { actualLanguage, actualTheme } = await ensureLanguageAndThemeLoaded(language, theme)

  // 创建新的 tokenizer
  const options: ShikiStreamTokenizerOptions = {
    highlighter,
    lang: actualLanguage,
    theme: actualTheme
  }

  const tokenizer = new ShikiStreamTokenizer(options)
  tokenizerMap.set(cacheKey, tokenizer)

  return tokenizer
}

// 高亮代码 chunk
async function highlightCodeChunk(
  callerId: string,
  chunk: string,
  language: string,
  theme: string
): Promise<HighlightChunkResult> {
  try {
    // 获取 tokenizer
    const tokenizer = await getStreamTokenizer(callerId, language, theme)

    // 处理代码 chunk
    const result = await tokenizer.enqueue(chunk)

    // 返回结果
    return {
      lines: [...result.stable, ...result.unstable],
      recall: result.recall
    }
  } catch (error) {
    logger.error('Worker failed to highlight code chunk:', error as Error)

    // 提供简单的 fallback
    const fallbackToken: ThemedToken = { content: chunk || '', color: '#000000', offset: 0 }
    return {
      lines: [[fallbackToken]],
      recall: 0
    }
  }
}

// 清理特定调用者的 tokenizer
function cleanupTokenizer(callerId: string): void {
  // 清理所有以callerId开头的缓存
  for (const key of tokenizerMap.keys()) {
    if (key.startsWith(`${callerId}-`)) {
      tokenizerMap.delete(key)
    }
  }
}

// 定义 worker 上下文类型
declare const self: DedicatedWorkerGlobalScope

// 监听消息
self.onmessage = async (e: MessageEvent<WorkerInboundMessage>) => {
  const { id, type } = e.data

  // 资产回包（p2-04）：不是请求，是主线程对 `assets-request` 的应答
  if (type === 'assets-result') {
    const payload = e.data as { result?: unknown[]; error?: string }
    settleAssetRequest(id, payload.result, payload.error)
    return
  }

  try {
    switch (type) {
      case 'init':
        if (e.data.languages && e.data.themes) {
          await initHighlighter(e.data.themes, e.data.languages)
          self.postMessage({ id, type: 'init-result', result: { success: true } } as WorkerResponse)
        } else {
          throw new Error('Missing required init parameters')
        }
        break

      case 'highlight':
        if (!highlighter) {
          throw new Error('Highlighter not initialized')
        }

        if (e.data.callerId && e.data.chunk && e.data.language && e.data.theme) {
          const result = await highlightCodeChunk(e.data.callerId, e.data.chunk, e.data.language, e.data.theme)
          self.postMessage({ id, type: 'highlight-result', result } as WorkerResponse)
        } else {
          throw new Error('Missing required highlight parameters')
        }
        break

      case 'cleanup':
        if (e.data.callerId) {
          cleanupTokenizer(e.data.callerId)
          self.postMessage({ id, type: 'cleanup-result', result: { success: true } } as WorkerResponse)
        } else {
          throw new Error('Missing callerId for cleanup')
        }
        break

      case 'dispose':
        tokenizerMap.clear()
        highlighter?.dispose()
        highlighter = null
        self.postMessage({ id, type: 'dispose-result', result: { success: true } } as WorkerResponse)
        break

      default:
        throw new Error(`Unknown command: ${type}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    self.postMessage({
      id,
      type: 'error',
      error: errorMessage
    } as WorkerResponse)
  }
}
