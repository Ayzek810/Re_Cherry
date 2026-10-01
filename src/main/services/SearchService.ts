import { is } from '@electron-toolkit/utils'
import { loggerService } from '@logger'
import { BrowserWindow, type Session, session } from 'electron'

const logger = loggerService.withContext('SearchService')

/**
 * 刮取窗口的专用会话（内存态，不带 `persist:` 前缀）。
 *
 * 为什么单开会话：刮取窗口加载的是**任意第三方页面**（搜索引擎结果页、抓取目标页）。
 * 它必须与应用自身的 `defaultSession` 隔离——否则被刮取的站点能读应用 cookie/存储。
 */
const SCRAPE_PARTITION = 'scrape'

/** 只允许 http(s)。`file:`、`data:`、`javascript:` 等一律拒绝。 */
function isAllowedScrapeUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

let scrapeSessionConfigured = false
/** 取得（并在首次调用时配置）刮取专用会话：禁一切权限请求与下载。 */
function scrapeSession(): Session {
  const target = session.fromPartition(SCRAPE_PARTITION)
  if (!scrapeSessionConfigured) {
    scrapeSessionConfigured = true
    target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    target.on('will-download', (event) => event.preventDefault())
  }
  return target
}

export class SearchService {
  private static instance: SearchService | null = null
  private searchWindows: Record<string, BrowserWindow> = {}
  public static getInstance(): SearchService {
    if (!SearchService.instance) {
      SearchService.instance = new SearchService()
    }
    return SearchService.instance
  }

  private async createNewSearchWindow(uid: string, show: boolean = false): Promise<BrowserWindow> {
    const newWindow = new BrowserWindow({
      width: 1280,
      height: 768,
      show,
      webPreferences: {
        // 刮取窗口只经 executeJavaScript 读 `document.documentElement.outerHTML`，不需要任何
        // Node 能力。此前为 `nodeIntegration: true` + `contextIsolation: false`（上游 V1 同形），
        // 等于把「打开一个被投毒的搜索结果页」变成宿主机任意代码执行（v1 二轮审查 m2-01）。
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: is.dev,
        session: scrapeSession()
      }
    })

    this.searchWindows[uid] = newWindow
    newWindow.on('closed', () => delete this.searchWindows[uid])

    // 加固：不许开新窗口，不许导航到非 http(s)。
    newWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    newWindow.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isAllowedScrapeUrl(targetUrl)) {
        logger.warn(`search window blocked navigation to ${targetUrl}`)
        event.preventDefault()
      }
    })

    newWindow.webContents.userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)  Safari/537.36'

    return newWindow
  }

  /**
   * v0.3.2 批次2 自 CS_V1 移植（上游主进程 SearchService.closeSearchWindow 同款实现）：
   * 按 uid 关闭并摘除刮取窗口——修复 openUrlInSearchWindow 只建不关、窗口按 uid
   * 无限累积的泄漏；与 createNewSearchWindow 的登记/摘除形态对称。
   */
  public async closeSearchWindow(uid: string): Promise<void> {
    const window = this.searchWindows[uid]
    if (window) {
      window.close()
      delete this.searchWindows[uid]
    }
  }

  public async openUrlInSearchWindow(uid: string, url: string): Promise<any> {
    if (!isAllowedScrapeUrl(url)) {
      // 失败不伪装：非法 scheme 直接拒绝，不静默加载空页。
      throw new Error(`search window refused non-http(s) url: ${url.slice(0, 80)}`)
    }
    let window = this.searchWindows[uid]
    logger.debug(`Searching with URL: ${url}`)
    if (window === undefined) {
      window = await this.createNewSearchWindow(uid)
    }
    try {
      // loadURL 自身即等待 did-finish-load 并在 did-fail-load 时拒绝——错误原文
      // （ERR_CONNECTION_*/代理失败等）直接上抛，不再吞成"10 秒后刮到空页"。
      await window.loadURL(url)
    } catch (error) {
      logger.error(`search window load failed for ${url}`, error instanceof Error ? error : new Error(String(error)))
      throw new Error(`search window page load failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 500ms 定值：等页面 JS 把结果渲染进 DOM（上游同值；上游的
    // "loadURL 之后再注册 did-finish-load + 10s 兜底"是死等——事件在 loadURL
    // await 期间已触发，监听器永远不响，每次搜索白等满 10s，本版一并修掉）。
    await new Promise<void>((resolve) => setTimeout(resolve, 500))

    // Get the page content after ensuring it's fully loaded
    return await window.webContents.executeJavaScript('document.documentElement.outerHTML')
  }
}

export const searchService = SearchService.getInstance()
