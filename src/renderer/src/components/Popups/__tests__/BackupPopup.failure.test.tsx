/**
 * 备份失败必须可见、且弹窗不能死锁。
 *
 * 缺陷原状：onOk 里 `await backup()` 没有 try/catch，失败时既不关弹窗也不提示；
 * 而 `isDisabled` 由进度阶段推导（未完成阶段恒为 true），确定与取消两个按钮同时被禁用，
 * 加上 maskClosable={false}，用户面对一个进度条卡住、什么按钮都点不动、也没有报错的模态框。
 *
 * antd Modal 被替换成最小壳：这里要钉的是弹窗自己的状态机（open / 按钮可用性 / 失败信号），
 * 不是 antd 的动画。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BackupPopupContainer } from '../BackupPopup'

const { backupMock } = vi.hoisted(() => ({ backupMock: vi.fn() }))

vi.mock('@renderer/services/BackupService', () => ({ backup: backupMock }))

interface ModalShellProps {
  open?: boolean
  onOk?: () => void
  onCancel?: () => void
  okButtonProps?: { disabled?: boolean }
  cancelButtonProps?: { disabled?: boolean }
  children?: ReactNode
}

vi.mock('antd', () => ({
  Modal: ({ open, onOk, onCancel, okButtonProps, cancelButtonProps, children }: ModalShellProps) => (
    <div data-testid="modal" data-modal-open={String(Boolean(open))}>
      <button type="button" data-testid="modal-ok" disabled={okButtonProps?.disabled} onClick={onOk}>
        backup.confirm.button
      </button>
      <button type="button" data-testid="modal-cancel" disabled={cancelButtonProps?.disabled} onClick={onCancel}>
        Cancel
      </button>
      {children}
    </div>
  ),
  Progress: () => <div data-testid="progress" />
}))

// 保留模块其余导出（i18n/index.ts 依赖 initReactI18next，整体替换会让测试文件加载失败）。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

describe('BackupPopup failure handling', () => {
  beforeEach(() => {
    backupMock.mockReset()
    // 进度订阅走 preload 的具名事件桥（`window.api.events`），不再是
    // `window.electron.ipcRenderer.on`。桩保留两者，避免测试只钉在旧通路上。
    window.electron = {
      ipcRenderer: { on: vi.fn(() => vi.fn()), send: vi.fn(), invoke: vi.fn() },
      process: { platform: 'win32', env: { NODE_ENV: 'test' } }
    } as any
    window.api = {
      events: { onBackupProgress: vi.fn(() => vi.fn()), onRestoreProgress: vi.fn(() => vi.fn()) }
    } as any
    window.toast = { success: vi.fn(), error: vi.fn() } as any
  })

  it('surfaces the failure and keeps the dialog closable when the backup rejects', async () => {
    backupMock.mockRejectedValue(new Error('disk full'))
    render(<BackupPopupContainer resolve={vi.fn()} />)

    fireEvent.click(screen.getByTestId('modal-ok'))

    await waitFor(() => expect(screen.getByTestId('backup-error')).toHaveTextContent('disk full'))
    expect(window.toast.error).toHaveBeenCalled()

    // 关键断言：失败后弹窗仍然打开，且两个按钮都不能被禁用 —— 没有死锁。
    expect(screen.getByTestId('modal')).toHaveAttribute('data-modal-open', 'true')
    expect(screen.getByTestId('modal-ok')).toBeEnabled()
    expect(screen.getByTestId('modal-cancel')).toBeEnabled()

    fireEvent.click(screen.getByTestId('modal-cancel'))
    await waitFor(() => expect(screen.getByTestId('modal')).toHaveAttribute('data-modal-open', 'false'))
  })

  it('closes the dialog after a successful backup', async () => {
    backupMock.mockResolvedValue(undefined)
    render(<BackupPopupContainer resolve={vi.fn()} />)

    fireEvent.click(screen.getByTestId('modal-ok'))

    await waitFor(() => expect(backupMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('modal')).toHaveAttribute('data-modal-open', 'false'))
    expect(screen.queryByTestId('backup-error')).not.toBeInTheDocument()
  })
})
