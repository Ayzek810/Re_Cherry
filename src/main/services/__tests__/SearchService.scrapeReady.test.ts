/**
 * 刮取窗口的结果渲染等待。
 *
 * 原来是 `await new Promise(resolve => setTimeout(resolve, 500))`——无条件把 500ms 纯延迟加在
 * 每个搜索请求上（`fetchSerpPage` 一级路径对每个请求都付一次）。改成轮询「正文节点是否已进
 * DOM」：就绪立即返回；到上限（2.5s）仍未就绪也返回一次（诚实降级，不无限等）。
 *
 * 本文件驱动 `openUrlInSearchWindow` 的真实等待循环 + executeJavaScript 取值，断言：
 * 1. 页面已就绪时不付固定延迟（探针首个答案 true 即返回）；
 * 2. 页面延迟渲染时按轮询等到就绪；
 * 3. 永不就绪时在上限内返回（不挂死），仍取一次 outerHTML。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

type FakeContents = {
  isDestroyed: () => boolean
  executeJavaScript: ReturnType<typeof vi.fn>
  userAgent: string
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

const fakeContents: FakeContents = {
  isDestroyed: () => false,
  executeJavaScript: vi.fn(),
  userAgent: '',
  setWindowOpenHandler: vi.fn(),
  on: vi.fn()
}

const fakeWindow = {
  webContents: fakeContents,
  loadURL: vi.fn(async () => {}),
  on: vi.fn(),
  close: vi.fn(),
  isDestroyed: () => false
}

vi.mock('electron', () => {
  const session = {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      on: vi.fn()
    }))
  }
  return {
    __esModule: true,
    BrowserWindow: vi.fn(() => fakeWindow),
    session,
    default: { BrowserWindow: vi.fn(() => fakeWindow), session }
  }
})

const { searchService } = await import('../SearchService')

/** 模拟页面脚本：`document.documentElement.outerHTML` 返回固定正文。 */
const PAGE_HTML = '<html><body><div class="result">x</div></body></html>'

function installProbe(answers: boolean[], finalHtml = PAGE_HTML): number[] {
  const callTimes: number[] = []
  fakeContents.executeJavaScript.mockImplementation((script: string) => {
    if (script.includes('outerHTML')) return Promise.resolve(finalHtml)
    callTimes.push(Date.now())
    // 探针脚本：按答案序列返回；用完则返回最后一个
    const next = answers.length > 0 ? answers.shift()! : false
    return Promise.resolve(next)
  })
  return callTimes
}

describe('SearchService 刮取渲染等待', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeContents.isDestroyed = () => false
    fakeWindow.loadURL.mockImplementation(async () => {})
  })

  it('页面已就绪：探针一次命中即返回，不付固定 500ms', async () => {
    const probeTimes = installProbe([true])

    const started = Date.now()
    const html = await searchService.openUrlInSearchWindow('uid-ready', 'https://example.com/search')
    const elapsed = Date.now() - started

    expect(html).toBe(PAGE_HTML)
    expect(probeTimes).toHaveLength(1)
    expect(elapsed).toBeLessThan(400)
  })

  it('页面延迟渲染：轮询到就绪为止（多于一次探针）', async () => {
    const probeTimes = installProbe([false, false, true])

    const html = await searchService.openUrlInSearchWindow('uid-slow', 'https://example.com/search')

    expect(html).toBe(PAGE_HTML)
    expect(probeTimes.length).toBeGreaterThanOrEqual(3)
    const last = probeTimes.at(-1) ?? 0
    const first = probeTimes[0] ?? 0
    expect(last - first).toBeGreaterThanOrEqual(150)
  })

  it('页面永不就绪：上限内返回并仍取一次 outerHTML（不挂死）', async () => {
    // 探针全部 false（序列用完后默认 false）
    installProbe([])

    const started = Date.now()
    const html = await searchService.openUrlInSearchWindow('uid-never', 'https://example.com/search')
    const elapsed = Date.now() - started

    expect(html).toBe(PAGE_HTML)
    expect(elapsed).toBeLessThan(6000)
  }, 15000)

  it('探针抛错（页面正在导航/已销毁）：不再轮询，交回调用方如实上抛', async () => {
    fakeContents.executeJavaScript.mockImplementation((script: string) => {
      if (script.includes('outerHTML')) return Promise.resolve(PAGE_HTML)
      return Promise.reject(new Error('Script failed to execute'))
    })

    const started = Date.now()
    const html = await searchService.openUrlInSearchWindow('uid-probe-error', 'https://example.com/search')
    expect(html).toBe(PAGE_HTML)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('非 http(s) 目标直接拒绝（失败不伪装成空页）', async () => {
    await expect(searchService.openUrlInSearchWindow('uid-bad', 'file:///etc/passwd')).rejects.toThrow(
      'refused non-http(s) url'
    )
  })
})
