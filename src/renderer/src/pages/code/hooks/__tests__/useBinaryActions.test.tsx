/**
 * 二轮审查 f2-50：`runInstallTool` 的 catch 分支静默失败。
 *
 * 有 toast 的那一臂只覆盖"主进程正常返回 `{success:false}`"。若 IPC 调用本身 reject
 *（通道缺失、preload 未桥、主进程 handler 抛错），旧实现只写日志：主进程什么都没记录，
 * 版本卡也不会出现失败行，用户看到的是"安装按钮转一圈又变回来"（§9「Never fail silently …
 * Do this also for fire-and-forget writes」，`onInstall: () => void install(...)` 正是这种写法）。
 *
 * 行为级断言：① install/upgrade 的 IPC reject 都有 toast，且文案键按动作区分；
 * ② 详情走共享截断单点（`utils/errorDetail.ts` 的 200 字上限），不是整段日志。
 */
import { CodeCli } from '@shared/types/codeCli'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBinaryActions } from '../useBinaryActions'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const ERROR_DETAIL_LIMIT = 200

function installBinaryBridge() {
  const install = vi.fn()
  const remove = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    codeCli: {
      binary: {
        install,
        remove,
        onInstallProgress: vi.fn(() => vi.fn())
      }
    }
  }
  return { install, remove }
}

describe('useBinaryActions（f2-50：IPC reject 必须有可见信号）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { toast: unknown }).toast = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn()
    }
  })

  it('install：IPC reject ⇒ toast.error(code.install_failed: 截断详情)，且 busy 集合复位', async () => {
    const bridge = installBinaryBridge()
    bridge.install.mockRejectedValue(new Error('x'.repeat(300)))

    const { result } = renderHook(() => useBinaryActions())

    await act(async () => {
      await result.current.install(CodeCli.DEEPSEEK_HARNESS)
    })

    expect(window.toast.error).toHaveBeenCalledTimes(1)
    const text = (window.toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(text.startsWith('code.install_failed: ')).toBe(true)
    // 共享截断单点：200 字上限（整段 300 字不得原样进 toast）。
    expect(text).toHaveLength('code.install_failed: '.length + ERROR_DETAIL_LIMIT)
    expect(result.current.installingTools.size).toBe(0)
    expect(result.current.installProgress).toBeNull()
  })

  it('upgrade：IPC reject ⇒ toast.error(code.upgrade_failed: …)（文案键按动作区分）', async () => {
    const bridge = installBinaryBridge()
    bridge.install.mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useBinaryActions())

    await act(async () => {
      await result.current.upgrade(CodeCli.DEEPSEEK_HARNESS)
    })

    expect(window.toast.error).toHaveBeenCalledWith('code.upgrade_failed: boom')
    expect(result.current.upgradingTools.size).toBe(0)
  })

  it('反向对照：主进程返回 {success:false} 仍然走原臂（结果里的 message）', async () => {
    const bridge = installBinaryBridge()
    bridge.install.mockResolvedValue({ success: false, message: 'ERR_PNPM_FETCH_404' })

    const { result } = renderHook(() => useBinaryActions())

    await act(async () => {
      await result.current.install(CodeCli.DEEPSEEK_HARNESS)
    })

    expect(window.toast.error).toHaveBeenCalledWith('code.install_failed: ERR_PNPM_FETCH_404')
    expect(window.toast.success).not.toHaveBeenCalled()
  })
})
