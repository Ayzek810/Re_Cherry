import '@renderer/i18n'

import UpdateAppButton from '@renderer/pages/home/components/UpdateAppButton'
import type { AppUpdateState } from '@shared/types/appUpdate'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 顶栏"有新版本"按钮的行为契约。
 *
 * 只在该版本可用、且没被忽略时出现；点击是用户显式动作 —— 开始下载并跳到关于页。
 * 若把"忽略"或"已下载"也算作可点，用户会看到一个永远点不出下文的按钮。
 */

const mocks = vi.hoisted(() => ({
  update: null as AppUpdateState | null,
  navigate: vi.fn(),
  download: vi.fn()
}))

vi.mock('@renderer/hooks/useRuntime', () => ({ useRuntime: () => ({ update: mocks.update }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))

const state = (patch: Partial<AppUpdateState>): AppUpdateState => ({
  phase: 'idle',
  currentVersion: '0.5.3',
  latestVersion: null,
  releaseNotes: null,
  releasePageUrl: null,
  assetName: null,
  assetSize: null,
  progress: null,
  ignored: false,
  verified: null,
  manual: false,
  errorCode: null,
  errorDetail: null,
  ...patch
})

describe('UpdateAppButton', () => {
  beforeEach(() => {
    mocks.update = null
    mocks.navigate.mockReset()
    mocks.download.mockReset()
    mocks.download.mockResolvedValue(undefined)
    vi.stubGlobal('api', { update: { download: mocks.download } })
  })

  it('没有状态或没有可用版本时不渲染', () => {
    const { container, rerender } = render(<UpdateAppButton />)
    expect(container).toBeEmptyDOMElement()

    mocks.update = state({ phase: 'latest', latestVersion: '0.5.3' })
    rerender(<UpdateAppButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('发现新版本时出现，并带上版本号', () => {
    mocks.update = state({ phase: 'available', latestVersion: '1.0.0' })
    render(<UpdateAppButton />)
    expect(screen.getByRole('button')).toHaveTextContent('1.0.0')
  })

  it('点击即开始下载并跳到关于页', () => {
    mocks.update = state({ phase: 'available', latestVersion: '1.0.0' })
    render(<UpdateAppButton />)

    fireEvent.click(screen.getByRole('button'))

    expect(mocks.download).toHaveBeenCalledTimes(1)
    expect(mocks.navigate).toHaveBeenCalledWith('/settings/about')
  })

  it('被忽略的版本不提示', () => {
    mocks.update = state({ phase: 'available', latestVersion: '1.0.0', ignored: true })
    const { container } = render(<UpdateAppButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('下载中与已下载都不再提示（按钮只服务"发现"这一刻）', () => {
    mocks.update = state({ phase: 'downloading', latestVersion: '1.0.0' })
    const { container, rerender } = render(<UpdateAppButton />)
    expect(container).toBeEmptyDOMElement()

    mocks.update = state({ phase: 'downloaded', latestVersion: '1.0.0' })
    rerender(<UpdateAppButton />)
    expect(container).toBeEmptyDOMElement()
  })
})
