/**
 * `useMinappPopup` 的缓存重建不得在渲染期 dispatch。
 *
 * 改动前：「缓存数量大小发生了改变」这段在渲染期执行，重建会用 `minAppsCache.set()`
 * 回填旧条目 → LRU 的 `onInsert` 同步 `dispatch(setOpenedKeepAliveMinapps(...))`
 * （`disposeAfter` 还会 `dispatch` + `TabsService.closeTab`）—— 渲染另一个组件时
 * 更新 store 是非法副作用。
 *
 * 断言：任何一次渲染期间 dispatch 调用数都不增加（探针在 hook 调用前后各取一次计数）；
 * 重建仍然发生（发生在 effect 中）且旧缓存条目被带过去。
 */
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchSpy, fakeState } = vi.hoisted(() => ({
  dispatchSpy: vi.fn(),
  fakeState: {
    settings: { maxKeepAliveMinapps: 3, navbarPosition: 'left' as const },
    runtime: { openedKeepAliveMinapps: [], openedOneOffMinapp: null, minappShow: false }
  }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => fakeState },
  useAppDispatch: () => dispatchSpy,
  useAppSelector: (selector: (state: unknown) => unknown) => selector(fakeState)
}))
vi.mock('@renderer/config/minapps', () => ({ allMinApps: [] }))
vi.mock('@renderer/services/TabsService', () => ({
  default: { getTabs: vi.fn(() => []), closeTab: vi.fn(), setMinAppsCache: vi.fn() }
}))
vi.mock('@renderer/services/NavigationService', () => ({ default: { navigate: vi.fn() } }))
vi.mock('@renderer/utils/webviewStateManager', () => ({ clearWebviewState: vi.fn() }))

import { setOpenedKeepAliveMinapps } from '@renderer/store/runtime'
import type { MinAppType } from '@renderer/types'

import { useMinappPopup } from '../useMinappPopup'

const createApp = (id: string): MinAppType =>
  ({ id, name: id, url: `https://${id}.example.com`, logo: `logo-${id}` }) as MinAppType

/** 渲染期 dispatch 探针：每次渲染在 hook 调用前后各取一次计数。 */
const renderPhaseDispatches: number[] = []
let latest: ReturnType<typeof useMinappPopup> | null = null

const Probe = ({ max }: { max: number }) => {
  fakeState.settings.maxKeepAliveMinapps = max
  const before = dispatchSpy.mock.calls.length
  latest = useMinappPopup()
  const after = dispatchSpy.mock.calls.length
  if (after !== before) renderPhaseDispatches.push(after - before)
  return null
}

beforeEach(() => {
  dispatchSpy.mockClear()
  renderPhaseDispatches.length = 0
})

describe('useMinappPopup ：渲染期不更新 store', () => {
  it('容量变化的重建只发生在 effect 中，渲染期零 dispatch 且条目保留', () => {
    const { rerender } = render(<Probe max={3} />)
    expect(latest!.minAppsCache.max).toBe(3)
    expect(renderPhaseDispatches).toEqual([])

    // 事件处理器路径（合法副作用）：打开一个 keep-alive minapp 写入缓存
    act(() => {
      latest!.openMinappKeepAlive(createApp('alpha'))
    })
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
    expect(latest!.minAppsCache.get('alpha')?.id).toBe('alpha')

    // 容量 3 → 5 触发重建
    rerender(<Probe max={5} />)

    // 核心断言：整个渲染期（含重建后的强制渲染）没有任何 dispatch
    expect(renderPhaseDispatches).toEqual([])

    // 重建确实发生（在 effect 中），max 更新且旧条目被带过去
    expect(latest!.minAppsCache.max).toBe(5)
    expect(latest!.minAppsCache.get('alpha')?.id).toBe('alpha')

    const keepAliveCalls = dispatchSpy.mock.calls.filter(([action]) => action.type === setOpenedKeepAliveMinapps.type)
    expect(keepAliveCalls.length).toBeGreaterThan(0)
    expect(keepAliveCalls[keepAliveCalls.length - 1][0].payload.map((app: MinAppType) => app.id)).toContain('alpha')
  })
})
