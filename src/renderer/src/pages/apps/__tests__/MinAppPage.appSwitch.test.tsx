/**
 * 二轮审查 f2-54：`MinAppPage` 的每应用状态（`isReady` / `currentUrl`）只在初始化器里算一次，而组件
 * 实例跨 `appId` 存活（路由 `/apps/:appId` 没有 `key`，标签页切换走 `navigate(tab.path)`）。
 *
 * 为什么是问题：从 `/apps/A` 切到 `/apps/B` 后，工具栏"在浏览器打开"会打开 **A** 的地址，
 * B 的 `LoadingMask` 不显示（webview 就绪前那块区域静默留白）。
 *
 * 行为级断言：
 *   ① 切到未加载的 B：`isWebviewReady` 变 false、`currentUrl` 不再带 A 的地址、加载遮罩出现；
 *   ② 附着到 webview 元素时从**该元素**读回当前地址（`getURL()` 被调用），而不是沿用上一条应用的值；
 *   ③ 切回已加载的 A：就绪状态按该应用重新取值。
 */
import '@renderer/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const APP_A = { id: 'app-a', name: 'App A', url: 'https://a.example.com' }
const APP_B = { id: 'app-b', name: 'App B', url: 'https://b.example.com' }

let loadedApps = new Set<string>()
let currentAppId = 'app-a'
let minappsSnapshot: Array<Record<string, unknown>> = [APP_A, APP_B]

vi.mock('react-router-dom', () => ({
  useParams: () => ({ appId: currentAppId }),
  useNavigate: () => vi.fn()
}))

vi.mock('@renderer/hooks/useMinappPopup', () => ({
  useMinappPopup: () => ({ openMinappKeepAlive: vi.fn(), minAppsCache: undefined })
}))

vi.mock('@renderer/hooks/useMinapps', () => ({
  useMinapps: () => ({ minapps: minappsSnapshot })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useNavbarPosition: () => ({ isTopNavbar: true }),
  // 该页面不读 settings 字段；补 useSetting 只是为了让新增的导出面在桩上存在。
  useSetting: () => undefined
}))

vi.mock('@renderer/services/TabsService', () => ({
  default: { setMinAppsCache: vi.fn() }
}))

vi.mock('@renderer/utils/webviewStateManager', () => ({
  getWebviewLoaded: (appId: string) => loadedApps.has(appId),
  setWebviewLoaded: vi.fn(),
  onWebviewStateChange: () => () => {}
}))

// 两个子组件只作为观察窗：它们拿到的就是缺陷里被污染的两个值。
const toolbarProps: Array<Record<string, unknown>> = []
vi.mock('../../apps/components/MinimalToolbar', () => ({
  default: (props: Record<string, unknown>) => {
    toolbarProps.push(props)
    return <div data-testid="toolbar" />
  }
}))

const webviewSearchProps: Array<Record<string, unknown>> = []
vi.mock('../../apps/components/WebviewSearch', () => ({
  default: (props: Record<string, unknown>) => {
    webviewSearchProps.push(props)
    return <div data-testid="webview-search" />
  }
}))

import MinAppPage from '../MinAppPage'

// antd 组件（`Avatar`）会读 `window.matchMedia`，jsdom 没有实现。
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
}

function renderApp(appId: string) {
  currentAppId = appId
  return render(<MinAppPage />)
}

describe('MinAppPage 每应用状态随 appId 重置（f2-54）', () => {
  beforeEach(() => {
    toolbarProps.length = 0
    webviewSearchProps.length = 0
    loadedApps = new Set(['app-a'])
    minappsSnapshot = [APP_A, APP_B]
    document.body.innerHTML = ''
  })

  it('从已加载的 A 切到未加载的 B：就绪状态、地址、加载遮罩都跟着 appId 复位', () => {
    const { rerender } = renderApp('app-a')
    expect(webviewSearchProps.at(-1)?.isWebviewReady).toBe(true)
    expect(webviewSearchProps.at(-1)?.appId).toBe('app-a')
    expect(screen.queryByTestId('minapp-loading-mask')).toBeNull()

    currentAppId = 'app-b'
    rerender(<MinAppPage />)

    // 旧实现：`isReady` 停在上一条应用的 true → B 的就绪前遮罩不显示，搜索动作还会打到未就绪的 B 上。
    expect(webviewSearchProps.at(-1)?.isWebviewReady).toBe(false)
    expect(webviewSearchProps.at(-1)?.appId).toBe('app-b')
    // 旧实现：`currentUrl` 仍是 A 的内部地址 → "在浏览器打开"打开 A。
    expect(toolbarProps.at(-1)?.currentUrl).toBeNull()
    expect((toolbarProps.at(-1)?.app as { id?: string } | undefined)?.id).toBe('app-b')
    // 加载遮罩必须出现（组件渲染分支：`!isReady`）。
    expect(screen.getByTestId('minapp-loading-mask')).toBeInTheDocument()
  })

  it('重新附着到新 webview 元素时从该元素读回地址（不再沿用旧元素的值）', async () => {
    const staleElement = document.createElement('webview')
    staleElement.setAttribute('data-minapp-id', 'app-a')
    Object.assign(staleElement, { getURL: () => 'https://a.example.com/stale' })
    document.body.appendChild(staleElement)

    const { rerender } = renderApp('app-a')
    await waitFor(() => expect(toolbarProps.at(-1)?.currentUrl).toBe('https://a.example.com/stale'))

    // 池里换了一个同一 appId 的新元素（旧元素脱离文档）——`did-navigate-in-page` 在首帧加载时
    // 不触发，所以 `currentUrl` 只可能由"附着时读元素"来更新。
    staleElement.remove()
    const freshElement = document.createElement('webview')
    freshElement.setAttribute('data-minapp-id', 'app-a')
    const getURL = vi.fn(() => 'https://a.example.com/current')
    Object.assign(freshElement, { getURL })
    document.body.appendChild(freshElement)

    // 换一个 app 对象引用（同 id）以重跑附着 effect。
    minappsSnapshot = [{ ...APP_A }, APP_B]
    rerender(<MinAppPage />)

    await waitFor(() => expect(toolbarProps.at(-1)?.currentUrl).toBe('https://a.example.com/current'))
    expect(getURL).toHaveBeenCalled()
  })

  it('切回已加载的应用：就绪状态重新按该应用取值', () => {
    currentAppId = 'app-b'
    loadedApps = new Set()
    const { rerender } = render(<MinAppPage />)
    expect(webviewSearchProps.at(-1)?.isWebviewReady).toBe(false)

    loadedApps = new Set(['app-a'])
    currentAppId = 'app-a'
    rerender(<MinAppPage />)

    expect(webviewSearchProps.at(-1)?.isWebviewReady).toBe(true)
  })
})
