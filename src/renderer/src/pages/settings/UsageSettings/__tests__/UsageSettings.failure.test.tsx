import '@renderer/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 用量面板的失败渲染（v1 二轮审查 s2-06）。
 *
 * 修改前读取失败会被画成「0 用量 + 暂无数据」：数字 0 与空图看起来是结论而不是错误，
 * 用户据此认为统计坏了却找不到原因。现在失败必须显式可见，且不得画出 0。
 */

const queryUsageMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/services/usageStore', () => ({ queryUsage: queryUsageMock }))
vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'light' } })
}))

import UsageSettings from '../UsageSettings'

const summary = (requests: number) => ({
  requests,
  inputTokens: requests * 10,
  outputTokens: requests * 20,
  days: requests > 0 ? [{ date: '2026-09-30', requests, inputTokens: requests * 10, outputTokens: requests * 20 }] : [],
  byModel: requests > 0 ? [{ modelId: 'm1', requests, inputTokens: 10, outputTokens: 20 }] : []
})

beforeEach(() => {
  queryUsageMock.mockReset()
})

describe('用量面板的失败态', () => {
  it('读取失败渲染错误态与错误原因，不渲染「暂无数据」', async () => {
    queryUsageMock.mockResolvedValue({ ok: false, error: 'IndexedDB closed' })

    render(<UsageSettings />)

    await waitFor(() => expect(screen.getByText('IndexedDB closed')).toBeInTheDocument())
    expect(screen.queryByText(/No usage records in this range|该范围内暂无用量记录/)).toBeNull()
  })

  it('读取失败时三个汇总卡都渲染「—」而不是数字 0', async () => {
    queryUsageMock.mockResolvedValue({ ok: false, error: 'boom' })

    render(<UsageSettings />)

    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3))
    expect(screen.queryByText('0')).toBeNull()
  })

  it('读取成功时仍然渲染真实数字与按日数据', async () => {
    queryUsageMock.mockResolvedValue({ ok: true, summary: summary(3) })

    render(<UsageSettings />)

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument())
    expect(screen.getByText('2026-09-30')).toBeInTheDocument()
  })

  it('真的 0 条记录时渲染「暂无数据」（是结论，不是错误）', async () => {
    queryUsageMock.mockResolvedValue({ ok: true, summary: summary(0) })

    render(<UsageSettings />)

    await waitFor(() =>
      expect(screen.getAllByText(/No usage records in this range|该范围内暂无用量记录/).length).toBeGreaterThan(0)
    )
  })
})
