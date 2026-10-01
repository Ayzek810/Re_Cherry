/**
 * c2-18 行为测试：侧栏小程序弹窗的批量删除必须报「N 成功 / M 失败」。
 *
 * 原状：串行 `await` 落在同一个 `try` 里，第 k 条失败即跳出循环 —— 前 k-1 条已经真删了、
 * 剩下的没删，却只弹一条通用错误，用户无法知道到底删掉了几个；`selectedRowKeys` 也只在
 * 全成功路径才清空。正面违反家规「批量删除要报 N 成功 / M 失败」。
 *
 * 注意：本文件**不** mock `react-i18next`。`@renderer/i18n` 会 `.use(initReactI18next)`，
 * 与「异步工厂里 await importOriginal」互相等待，vitest 会在收集阶段死锁。这里让真实 i18n 跑，
 * 断言的正是「未合并的新键走 `defaultValue` 兜底」这条路。
 *
 * antd 换成最小壳：钉的是批量删除的结果记账，不是 antd 的表格渲染。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalBackupManager } from '../LocalBackupManager'

const mocks = vi.hoisted(() => ({
  listLocalBackupFiles: vi.fn(),
  deleteLocalBackupFile: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@renderer/services/BackupService', () => ({ restoreFromLocal: vi.fn() }))

interface TableShellProps {
  dataSource: { fileName: string }[]
  rowSelection: { onChange: (keys: string[]) => void }
}

vi.mock('antd', () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <div data-testid="modal">
      {children}
      <div data-testid="footer">{footer}</div>
    </div>
  ),
  Table: ({ dataSource, rowSelection }: TableShellProps) => (
    <div data-testid="table">
      <button
        type="button"
        data-testid="select-all"
        onClick={() => rowSelection.onChange(dataSource.map((row) => row.fileName))}>
        select
      </button>
    </div>
  ),
  Button: ({ children, ...rest }: { children?: ReactNode }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() }
}))

const FILES = [{ fileName: 'a.zip' }, { fileName: 'b.zip' }, { fileName: 'c.zip' }]

const confirmCalls: { onOk?: () => Promise<void> }[] = []

describe('LocalBackupManager batch delete reporting (c2-18)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirmCalls.length = 0
    ;(window as unknown as { toast: unknown }).toast = {
      error: mocks.toastError,
      success: mocks.toastSuccess,
      warning: vi.fn(),
      info: vi.fn()
    }
    ;(window as unknown as { modal: unknown }).modal = {
      confirm: (options: { onOk?: () => Promise<void> }) => {
        confirmCalls.push(options)
      }
    }
    ;(window as unknown as { api: unknown }).api = {
      backup: {
        listLocalBackupFiles: mocks.listLocalBackupFiles,
        deleteLocalBackupFile: mocks.deleteLocalBackupFile
      }
    }
  })

  const selectAllAndConfirm = async () => {
    render(<LocalBackupManager visible onClose={vi.fn()} localBackupDir="/backups" />)
    await waitFor(() => expect(mocks.listLocalBackupFiles).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('select-all'))
    await waitFor(() => expect(screen.getByTestId('footer')).toHaveTextContent('(3)'))

    fireEvent.click(screen.getByTestId('local-backup-delete-selected'))
    expect(confirmCalls).toHaveLength(1)
    await confirmCalls[0].onOk?.()
  }

  it('reports succeeded/failed counts and keeps only the failed keys selected', async () => {
    mocks.listLocalBackupFiles.mockResolvedValue([...FILES])
    // b.zip 删除失败；a/c 真删掉了。
    mocks.deleteLocalBackupFile.mockImplementation((fileName: string) =>
      fileName === 'b.zip' ? Promise.reject(new Error('locked')) : Promise.resolve(true)
    )

    await selectAllAndConfirm()

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    const [message] = mocks.toastError.mock.calls[0]
    // 关键：真的带上了成功/失败/总数三个数（新键已并入 locale；未并入时走 defaultValue 兜底）。
    expect(String(message)).toContain('2')
    expect(String(message)).toContain('1')
    expect(String(message)).toContain('3')
    expect(String(message)).not.toContain('{{')

    // 成功 toast 不得在部分失败时出现（那不是「删除成功」）。
    expect(mocks.toastSuccess).not.toHaveBeenCalled()

    // 只有真正没删掉的项留在选中集里，用户可以就地重试。
    await waitFor(() => expect(screen.getByTestId('footer')).toHaveTextContent('(1)'))
  })

  it('reports a plain success when every delete resolves', async () => {
    mocks.listLocalBackupFiles.mockResolvedValue([...FILES])
    mocks.deleteLocalBackupFile.mockResolvedValue(true)

    await selectAllAndConfirm()

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled())
    expect(String(mocks.toastSuccess.mock.calls[0][0])).toContain('3')
    expect(mocks.toastError).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('footer')).toHaveTextContent('(0)'))
  })
})
