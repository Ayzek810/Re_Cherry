/**
 * 小程序设置里的"交换"按钮只改本地 state，不落库。
 *
 * 对比同排的"重置"（会 `updateMinapps(allMinApps)` + `updateDisabledMinapps([])`）与列表内部的实际
 * 写入口（`MiniAppIconsManager.handleListUpdate`，拖拽/移动都会写），"交换"绕过了写入路径 ——
 * 关掉弹窗、或任何触发 store→本地同步 effect 的变化（切地区、拖一个图标）都会把界面弹回原样。
 *
 * 行为级断言：点"交换"后两个列表**都**被写回 store，且固定项里不再留下被禁用的应用。
 */
import '@renderer/i18n'

import store from '@renderer/store'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { APP_A, APP_B, APP_C, updateMinapps, updateDisabledMinapps, updatePinnedMinapps } = vi.hoisted(() => ({
  APP_A: { id: 'app-a', name: 'App A', url: 'https://a.example.com' },
  APP_B: { id: 'app-b', name: 'App B', url: 'https://b.example.com' },
  APP_C: { id: 'app-c', name: 'App C', url: 'https://c.example.com' },
  updateMinapps: vi.fn(),
  updateDisabledMinapps: vi.fn(),
  updatePinnedMinapps: vi.fn()
}))

vi.mock('@renderer/hooks/useMinapps', () => ({
  useMinapps: () => ({
    minapps: [APP_A],
    disabled: [APP_B],
    pinned: [APP_A, APP_B],
    updateMinapps,
    updateDisabledMinapps,
    updatePinnedMinapps
  })
}))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = { maxKeepAliveMinapps: 3, showOpenedMinappsInSidebar: false, minappsOpenLinkExternal: false }
  // 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key] }
})

vi.mock('@renderer/config/minapps', () => ({
  allMinApps: [APP_A, APP_B, APP_C]
}))

vi.mock('@renderer/components/Selector', () => ({
  default: () => <div data-testid="region-selector" />
}))

// 设置页的排版组件：与本次缺陷无关。
vi.mock('@renderer/pages/settings', () => ({
  SettingDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingDivider: () => <hr />,
  SettingRowTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

// 列表管理器只作为渲染占位：本测试观察的是"交换"是否调用了同一套写入 API。
vi.mock('../MiniAppIconsManager', () => ({
  default: () => <div data-testid="icons-manager" />
}))

import MiniAppSettings from '../MiniAppSettings'

function renderSettings() {
  return render(
    <Provider store={store}>
      <MiniAppSettings />
    </Provider>
  )
}

describe('MiniAppSettings 交换按钮落库', () => {
  beforeEach(() => {
    updateMinapps.mockReset()
    updateDisabledMinapps.mockReset()
    updatePinnedMinapps.mockReset()
  })

  it('点"交换"：两个列表都写回 store，固定项剔除被禁用的应用', () => {
    renderSettings()

    screen.getByRole('button', { name: 'Swap' }).click()

    // 旧实现：只改了本地 state，store 从未被写 → 关弹窗/切地区就弹回原样。
    expect(updateMinapps).toHaveBeenCalledTimes(1)
    expect(updateMinapps).toHaveBeenCalledWith([APP_B])
    expect(updateDisabledMinapps).toHaveBeenCalledTimes(1)
    expect(updateDisabledMinapps).toHaveBeenCalledWith([APP_A])
    // 交换后 A 变成被禁用：固定项里不能继续留着它。
    expect(updatePinnedMinapps).toHaveBeenCalledWith([APP_B])
  })
})
