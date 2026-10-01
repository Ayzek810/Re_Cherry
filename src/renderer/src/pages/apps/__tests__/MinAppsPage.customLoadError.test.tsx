/**
 * 跨区请求⑥ 的用户可见信号落地点：启动播种失败必须在应用页展示。
 *
 * `config/minapps.ts` 在渲染层启动期求值，此刻 `window.toast` 还没赋值（`TopView/index.tsx`
 * 在挂载 effect 里才设置）——当场弹 toast 会静默 no-op，失败就只剩一条日志。所以失败被记成
 * 一次性提示，由 `MinAppsPage` 挂载时取走并展示。本文件钉住这条"取走并展示"的连线。
 */
import '@renderer/i18n'

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { takeMock, toastMocks } = vi.hoisted(() => ({
  takeMock: vi.fn(),
  toastMocks: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() }
}))

vi.mock('@renderer/config/minapps', () => ({
  allMinApps: [],
  takeCustomMiniAppsLoadError: takeMock
}))

vi.mock('@renderer/hooks/useMinapps', () => ({
  useMinapps: () => ({ minapps: [] })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useNavbarPosition: () => ({ isTopNavbar: false, isLeftNavbar: true, isVerticalNavbar: false })
}))

vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  NavbarMain: ({ children }: { children?: unknown }) => <div>{children as never}</div>
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children }: { children?: unknown }) => <div>{children as never}</div>
}))

vi.mock('@renderer/components/MinApp/MinApp', () => ({ default: () => <div /> }))
vi.mock('../NewAppButton', () => ({ default: () => <div /> }))
vi.mock('../MiniappSettings/MinappSettingsPopup', () => ({ default: { show: vi.fn() } }))

import MinAppsPage from '../MinAppsPage'

describe('MinAppsPage 展示启动播种失败（r2-79/⑥）', () => {
  beforeEach(() => {
    takeMock.mockReset()
    toastMocks.error.mockReset()
    ;(window as unknown as { toast: unknown }).toast = toastMocks
  })

  it('有待展示的失败时，挂载即给出用户可见 error', () => {
    takeMock.mockReturnValue('settings.miniapps.custom.load_error')

    render(<MinAppsPage />)

    expect(toastMocks.error).toHaveBeenCalledWith('settings.miniapps.custom.load_error')
  })

  it('没有失败时不打扰用户', () => {
    takeMock.mockReturnValue(null)

    render(<MinAppsPage />)

    expect(toastMocks.error).not.toHaveBeenCalled()
  })
})
