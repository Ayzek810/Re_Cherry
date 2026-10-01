import '@renderer/i18n'

import AboutSettings from '@renderer/pages/settings/AboutSettings'
import type { AppUpdateState } from '@shared/types/appUpdate'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 关于页"版本更新"区的行为契约：手动检查、下载、取消、安装四个动作各自打对的通道，
 * 且进度与摘要结论如实呈现（未校验不许显示成"已校验"）。
 */

const mocks = vi.hoisted(() => ({
  update: null as AppUpdateState | null,
  check: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  install: vi.fn(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn()
}))

vi.mock('@renderer/hooks/useRuntime', () => ({ useRuntime: () => ({ update: mocks.update }) }))
vi.mock('@renderer/hooks/useMinappPopup', () => ({ useMinappPopup: () => ({ openSmartMinapp: vi.fn() }) }))

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

/** 页面里有 `<Link>`，必须给一个 Router 上下文。 */
const renderPage = () =>
  render(
    <MemoryRouter>
      <AboutSettings />
    </MemoryRouter>
  )

beforeEach(() => {
  // antd 的响应式栅格（Row/Col）与 Progress 依赖 matchMedia，jsdom 不提供。
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
  mocks.update = state({})
  for (const fn of [mocks.check, mocks.download, mocks.cancel, mocks.install]) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  mocks.getPrefs.mockReset()
  mocks.getPrefs.mockResolvedValue({ sourceUrl: '', autoDownload: false, ignoredVersion: null })
  mocks.setPrefs.mockReset()
  mocks.setPrefs.mockImplementation((patch: unknown) =>
    Promise.resolve({ sourceUrl: '', autoDownload: false, ignoredVersion: null, ...(patch as object) })
  )
  vi.stubGlobal('api', {
    update: {
      check: mocks.check,
      download: mocks.download,
      cancel: mocks.cancel,
      install: mocks.install,
      getPrefs: mocks.getPrefs,
      setPrefs: mocks.setPrefs
    },
    getAppInfo: vi.fn().mockResolvedValue({ version: '0.5.3', appPath: '/tmp' }),
    openWebsite: vi.fn()
  })
  window.toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } as unknown as typeof window.toast
})

describe('关于页的版本更新区', () => {
  it('手动检查打的是 manual 检查通道', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /检查更新|Check for updates/i }))
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith({ manual: true }))
  })

  it('有可用版本时给出下载入口，点它就是下载', async () => {
    mocks.update = state({ phase: 'available', latestVersion: '1.0.0' })
    renderPage()

    const download = await screen.findByRole('button', { name: /^下载$|^Download$/ })
    fireEvent.click(download)
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1))
  })

  it('下载中显示进度与速率，并能取消', async () => {
    mocks.update = state({
      phase: 'downloading',
      latestVersion: '1.0.0',
      progress: { percent: 42, transferred: 42 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 1024 * 1024 }
    })
    renderPage()

    expect(await screen.findByText(/42\.0 MB \/ 100\.0 MB/)).toBeInTheDocument()
    expect(screen.getByText(/1\.0 MB\/s/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /取消下载|Cancel download/i }))
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1))
  })

  it('下载完成后给安装入口；摘要未校验时如实说明', async () => {
    mocks.update = state({ phase: 'downloaded', latestVersion: '1.0.0', verified: null })
    renderPage()

    expect(await screen.findByText(/未做校验|was not verified/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重启并安装|Restart and install/i }))
    await waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1))
  })

  it('便携版只给说明，不给下载入口', async () => {
    mocks.update = state({ phase: 'error', latestVersion: '1.0.0', errorCode: 'unsupported' })
    renderPage()

    expect(await screen.findByText(/便携版|portable build/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^下载$|^Download$/ })).toBeNull()
  })

  it('更新源输入在失焦时写回偏好', async () => {
    renderPage()
    const input = await screen.findByPlaceholderText(/留空使用默认源|Leave empty/i)
    fireEvent.change(input, { target: { value: 'https://mirror.test/updates' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.setPrefs).toHaveBeenCalledWith({ sourceUrl: 'https://mirror.test/updates' }))
  })
})
