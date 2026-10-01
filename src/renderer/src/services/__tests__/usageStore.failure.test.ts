import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 用量读取的失败语义。
 *
 * 修改前 `queryUsage` 在 Dexie 读取失败时返回 `summarizeUsage([], range)` —— 一个合法的
 * 「空汇总」。调用方无法区分「读取失败」与「真的 0 条记录」，于是面板把数据库错误画成
 * 「0 用量 + 暂无数据」。这里锁住判别式结果。
 */

const toArrayMock = vi.hoisted(() => vi.fn())
const betweenMock = vi.hoisted(() => vi.fn())
const whereMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/databases', () => ({
  db: {
    usage_records: {
      where: whereMock
    }
  }
}))

import { queryUsage } from '../usageStore'

const range = { start: 0, end: 1000 }

beforeEach(() => {
  toArrayMock.mockReset()
  betweenMock.mockReset()
  whereMock.mockReset()
  betweenMock.mockReturnValue({ toArray: toArrayMock })
  whereMock.mockReturnValue({ between: betweenMock })
})

describe('queryUsage 的失败语义', () => {
  it('读取成功时返回 ok:true 与真实汇总（真的 0 条 = 合法空汇总）', async () => {
    toArrayMock.mockResolvedValue([])

    const result = await queryUsage(range)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.summary.requests).toBe(0)
      expect(result.summary.days).toEqual([])
    }
  })

  it('读取失败时返回 ok:false 与错误原因，而不是合法的空汇总', async () => {
    toArrayMock.mockRejectedValue(new Error('IndexedDB closed'))

    const result = await queryUsage(range)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('IndexedDB closed')
    }
    expect(result).not.toHaveProperty('summary')
  })

  it('失败与「真的 0」在返回值上可区分', async () => {
    toArrayMock.mockResolvedValue([])
    const empty = await queryUsage(range)

    toArrayMock.mockRejectedValue(new Error('boom'))
    const failed = await queryUsage(range)

    expect(empty.ok).toBe(true)
    expect(failed.ok).toBe(false)
  })
})
