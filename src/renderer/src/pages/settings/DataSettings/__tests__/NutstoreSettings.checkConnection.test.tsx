import '@renderer/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Nutstore 连接检测的失败路径。
 *
 * 被调方 `checkConnection` 会 reject（凭据 / 主机 / 路径写错时正是这条路径）。修改前
 * 函数内没有 try/catch，`setCheckConnectionLoading(false)` 永不执行：按钮永久转圈、
 * 状态停在旧值，用户既看不到失败原因也无法重试。对照 SiyuanSettings 的样板。
 */

const checkConnectionMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/services/NutstoreService', () => ({
  checkConnection: checkConnectionMock,
  backupToNutstore: vi.fn(),
  createDirectory: vi.fn(),
  restoreFromNutstore: vi.fn(),
  startNutstoreAutoSync: vi.fn(),
  stopNutstoreAutoSync: vi.fn()
}))
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      nutstore: {
        nutstoreToken: 'tok',
        nutstorePath: '/cherry-studio',
        nutstoreSyncInterval: 0,
        nutstoreAutoSync: false,
        nutstoreSyncState: {},
        nutstoreSkipBackupFile: false,
        nutstoreMaxBackups: 0
      }
    })
}))
vi.mock('@renderer/hooks/useNutstoreSSO', () => ({ useNutstoreSSO: () => vi.fn() }))
vi.mock('@renderer/components/WebdavModals', () => ({
  useWebdavBackupModal: () => ({
    isModalVisible: false,
    handleBackup: vi.fn(),
    handleCancel: vi.fn(),
    backuping: false,
    customFileName: '',
    setCustomFileName: vi.fn(),
    showBackupModal: vi.fn()
  }),
  WebdavBackupModal: () => null
}))
vi.mock('@renderer/components/WebdavBackupManager', () => ({ WebdavBackupManager: () => null }))
vi.mock('@renderer/components/Popups/NutsorePathPopup', () => ({ default: { show: vi.fn() } }))

import NutstoreSettings from '../NutstoreSettings'

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }

beforeEach(() => {
  checkConnectionMock.mockReset()
  vi.clearAllMocks()
  window.toast = toast as unknown as typeof window.toast
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    nutstore: { decryptToken: vi.fn().mockResolvedValue({ username: 'u', access_token: 'a' }) }
  }
})

const renderAndClickCheck = async () => {
  render(<NutstoreSettings />)
  const checkButton = await screen.findByRole('button', { name: /Check Connection|检查连接/i })
  checkButton.click()
  return checkButton
}

describe('Nutstore 连接检测', () => {
  it('检测抛错时按钮恢复可点并弹 error，而不是永久 loading', async () => {
    checkConnectionMock.mockRejectedValue(new Error('401 unauthorized'))

    await renderAndClickCheck()

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.success).not.toHaveBeenCalled()
    // loading 复位后按钮回到可点状态（antd loading 按钮带 ant-btn-loading 类）
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Check Connection|检查连接/i })
      expect(button.className).not.toContain('ant-btn-loading')
    })
  })

  it('检测返回 false 时报错并复位 loading', async () => {
    checkConnectionMock.mockResolvedValue(false)

    await renderAndClickCheck()

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Check Connection|检查连接/i })
      expect(button.className).not.toContain('ant-btn-loading')
    })
  })

  it('检测成功时报成功', async () => {
    checkConnectionMock.mockResolvedValue(true)

    await renderAndClickCheck()

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(toast.error).not.toHaveBeenCalled()
  })
})
