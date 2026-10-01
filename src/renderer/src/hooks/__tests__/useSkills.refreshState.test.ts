/**
 * r2-38：`useInstalledSkills.refresh` 必须如实报告加载态与失败态。
 *
 * 此前 `loading`/`error` 硬编码为 `false`/`null` 且失败只打日志，主进程扫描失败时切片保持原状
 * （首次进入即空），页面只能渲染"未安装任何技能"——失败伪装成空结果（§9）。这里钉住：
 * - 扫描期间 `loading === true`，结束后 `false`；
 * - 失败时 `error` 有值且给用户可见信号（toast.error）；
 * - 成功时清掉上一次的 error。
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const skillsList = vi.fn()
const toastError = vi.fn()
const dispatch = vi.fn()

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatch,
  useAppSelector: () => []
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/services/SkillSearchService', () => ({ searchSkills: vi.fn() }))

import { useInstalledSkills } from '../useSkills'

beforeEach(() => {
  skillsList.mockReset()
  toastError.mockReset()
  dispatch.mockReset()
  ;(window as unknown as { api: unknown }).api = { skills: { list: skillsList } }
  ;(window as unknown as { toast: unknown }).toast = { error: toastError, info: vi.fn(), success: vi.fn() }
})

describe('useInstalledSkills 的加载/失败态（r2-38）', () => {
  it('初始 loading 为 true；扫描成功后 loading=false 且 error=null', async () => {
    skillsList.mockResolvedValue([
      { id: 's1', folderName: 's1', name: 'S1', description: 'd', author: null, contentHash: 'h' }
    ])
    const { result } = renderHook(() => useInstalledSkills())

    // 初始态：没有错误，且**不再**是"已完成"的假象
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(true)

    await result.current.refresh()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(skillsList).toHaveBeenCalledTimes(1)
  })

  it('扫描失败：error 有值 + toast.error 可见信号 + loading 落回 false（不伪装成"未安装"）', async () => {
    skillsList.mockRejectedValue(new Error('skills scan failed'))
    const { result } = renderHook(() => useInstalledSkills())

    await result.current.refresh()

    await waitFor(() => expect(result.current.error).toBe('skills scan failed'))
    expect(result.current.loading).toBe(false)
    expect(toastError).toHaveBeenCalledWith('settings.skills.refreshFailed')
    // 失败不落切片（dispatch 只可能来自 setInstalledSkills，成功路径才调）
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('失败后再成功：error 被清掉（不留陈旧错误态）', async () => {
    skillsList.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([])
    const { result } = renderHook(() => useInstalledSkills())

    await result.current.refresh()
    await waitFor(() => expect(result.current.error).toBe('boom'))

    await result.current.refresh()
    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.loading).toBe(false)
  })
})
