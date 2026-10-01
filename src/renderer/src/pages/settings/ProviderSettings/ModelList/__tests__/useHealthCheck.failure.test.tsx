import type { Model, Provider } from '@renderer/types'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useHealthCheck } from '../useHealthCheck'

/**
 * 健康检查的失败信号。
 *
 * 修改前这里无条件用 `toast.info` 播 `summarizeHealthResults` 的汇总：整批失败时汇总
 * 文本是「0 个模型通过健康检测」，也就是把一次整体失败渲染成成功态。现在没有任何成功
 * 密钥时改走 `toast.error`；并且卸载后不再写状态。
 */

const checkModelsHealthMock = vi.hoisted(() =>
  vi.fn<(options: unknown, onModelChecked?: (r: unknown, i: number) => void) => Promise<unknown[]>>()
)
const popupShowMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/services/HealthCheckService', () => ({ checkModelsHealth: checkModelsHealthMock }))
vi.mock('../HealthCheckPopup', () => ({ default: { show: popupShowMock } }))
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined
}))

const provider = { id: 'p', name: 'P', apiKey: 'k' } as unknown as Provider
const model = (id: string): Model => ({ id, name: id }) as unknown as Model

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }

const Harness = ({ models }: { models: Model[] }) => {
  const { isChecking, runHealthCheck } = useHealthCheck(provider, models)
  return (
    <button type="button" onClick={() => void runHealthCheck()}>
      {isChecking ? 'checking' : 'idle'}
    </button>
  )
}

beforeEach(() => {
  checkModelsHealthMock.mockReset()
  popupShowMock.mockReset()
  vi.clearAllMocks()
  window.toast = toast as unknown as typeof window.toast
  popupShowMock.mockResolvedValue({ cancelled: false, apiKeys: ['k'], isConcurrent: true, timeout: 1000 })
})

describe('useHealthCheck 的失败信号', () => {
  it('整批失败时报 error toast，不报 info（不得渲染成「0/N 通过」的成功态）', async () => {
    checkModelsHealthMock.mockResolvedValue([
      { model: model('a'), status: 'failed', keyResults: [], error: 'Error: down' }
    ])

    render(<Harness models={[model('a')]} />)
    await act(async () => {
      screen.getByRole('button').click()
    })

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('有成功密钥时仍走 info toast（正常结果不是错误）', async () => {
    checkModelsHealthMock.mockResolvedValue([
      { model: model('a'), status: 'success', keyResults: [{ key: 'k', status: 'success', latency: 12 }] }
    ])

    render(<Harness models={[model('a')]} />)
    await act(async () => {
      screen.getByRole('button').click()
    })

    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('卸载后不再写状态（长跑网络请求的挂载守卫）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolveCheck: (value: unknown[]) => void = () => {}
    checkModelsHealthMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve
        })
    )

    const { unmount } = render(<Harness models={[model('a')]} />)
    await act(async () => {
      screen.getByRole('button').click()
    })

    unmount()
    await act(async () => {
      resolveCheck([{ model: model('a'), status: 'success', keyResults: [] }])
    })

    const updateWarnings = errorSpy.mock.calls.filter((call) => String(call[0]).includes('unmounted'))
    expect(updateWarnings).toHaveLength(0)
    errorSpy.mockRestore()
  })
})
