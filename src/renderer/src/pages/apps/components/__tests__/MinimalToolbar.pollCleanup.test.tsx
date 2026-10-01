/**
 * `MinimalToolbar` 的附着轮询在卸载后仍会继续（定时器 + rAF 未收口）。
 *
 * 缺陷形态：`setTimeout` 触发后没有把句柄置空，`requestAnimationFrame` 的句柄从未保存/取消。
 * 若在"timeout 已触发、rAF 尚未执行"的窗口内卸载：清理阶段清不掉任何东西，rAF 回调仍会跑，
 * `attachListeners()` 为 false 就再排一条**永无人清理**的 timeout 链（上限 30 次、
 * 指数退避到 1s，合计约 30 秒持续做 rAF + 引用检查）。
 *
 * 行为级断言：
 *   ① 卸载时 rAF/S 定时器都被取消（`cancelAnimationFrame` / `clearTimeout` 被调用）；
 *   ② 残留的 rAF 回调即使被执行，也**不会再排新的定时器**（取消标志位生效）。
 */
import '@renderer/i18n'

import store from '@renderer/store'
import { render } from '@testing-library/react'
import type { WebviewTag } from 'electron'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@renderer/hooks/useMinapps', () => ({
  useMinapps: () => ({ pinned: [], updatePinnedMinapps: vi.fn() })
}))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = { minappsOpenLinkExternal: false }
  // 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key] }
})

vi.mock('@renderer/config/minapps', () => ({ allMinApps: [] }))

import MinimalToolbar from '../MinimalToolbar'

const APP = { id: 'app-a', name: 'App A', url: 'https://a.example.com' }

const frames: FrameRequestCallback[] = []
const timeouts: Array<() => void> = []
let cancelAnimationFrameSpy: ReturnType<typeof vi.fn>
let clearTimeoutSpy: ReturnType<typeof vi.fn>

function renderToolbar() {
  const webviewRef = { current: null } as unknown as React.RefObject<WebviewTag | null>
  return render(
    <Provider store={store}>
      <MinimalToolbar
        app={APP as never}
        webviewRef={webviewRef}
        currentUrl={null}
        onReload={vi.fn()}
        onOpenDevTools={vi.fn()}
      />
    </Provider>
  )
}

describe('MinimalToolbar 附着轮询的卸载收口', () => {
  beforeEach(() => {
    frames.length = 0
    timeouts.length = 0
    cancelAnimationFrameSpy = vi.fn()
    clearTimeoutSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameSpy)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      timeouts.push(callback)
      return timeouts.length as unknown as NodeJS.Timeout
    }) as unknown as typeof setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(clearTimeoutSpy as unknown as typeof clearTimeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('卸载时收口定时器与 rAF，且残留的 rAF 回调不再排新定时器', () => {
    // 第一次轮询：timeout（100ms）尚未触发。
    const { unmount } = renderToolbar()
    expect(timeouts.length).toBe(1)

    // 让第一个 timeout 触发 → 排出一个 rAF；此时组件仍挂载。
    timeouts[0]()
    expect(frames.length).toBe(1)

    // 在"timeout 已触发、rAF 还没跑"的瞬间卸载：旧实现的清理阶段清不掉任何东西。
    unmount()
    expect(cancelAnimationFrameSpy).toHaveBeenCalled()
    expect(clearTimeoutSpy).toHaveBeenCalled()

    const pendingFrame = frames.at(-1) as FrameRequestCallback
    const timeoutsBefore = timeouts.length
    pendingFrame(0)
    // 旧实现：这里会再排一条无人清理的 timeout（约 30 秒的退避轮询链）。
    expect(timeouts.length).toBe(timeoutsBefore)
  })

  it('正常路径仍然排下一轮（卸载守卫没有把轮询本身掐掉）', () => {
    renderToolbar()
    expect(timeouts.length).toBe(1)

    timeouts[0]()
    frames.at(-1)?.(0)

    // 第一次 rAF 尝试后 webview 仍未出现 → 按指数退避排下一轮。
    expect(timeouts.length).toBe(2)
  })
})
