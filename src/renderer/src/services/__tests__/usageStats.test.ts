import { describe, expect, it } from 'vitest'

import {
  filterUsageRecords,
  summarizeUsage,
  usageDateKey,
  usageRangeForPreset,
  type UsageRecord
} from '../usageStats'

/**
 * 用量统计纯函数层（services/usageStats.ts，v0.4.7）单测：
 * 预设范围边界（含端/本地零点）、日期键本地时区、过滤、聚合（总量/按日/按模型排序）。
 */
function record(partial: Partial<UsageRecord>): UsageRecord {
  return {
    timestamp: 0,
    topicId: 't',
    assistantId: 'a',
    modelId: 'm',
    inputTokens: 0,
    outputTokens: 0,
    ...partial
  }
}

// 固定"现在"：本地时区 2026-09-30 18:00
const NOW = new Date(2026, 8, 30, 18, 0, 0).getTime()

describe('usageRangeForPreset', () => {
  it('today = 本地今天零点起，含端', () => {
    const range = usageRangeForPreset('today', NOW)
    expect(range.end).toBe(NOW)
    expect(range.start).toBe(new Date(2026, 8, 30, 0, 0, 0).getTime())
  })

  it('7d = 从 7 天前的本地零点起', () => {
    const range = usageRangeForPreset('7d', NOW)
    expect(range.start).toBe(new Date(2026, 8, 24, 0, 0, 0).getTime())
  })

  it('all = 从 0 起', () => {
    const range = usageRangeForPreset('all', NOW)
    expect(range.start).toBe(0)
  })
})

describe('usageDateKey', () => {
  it('按本地时区产出 YYYY-MM-DD', () => {
    expect(usageDateKey(new Date(2026, 8, 30, 8, 30).getTime())).toBe('2026-09-30')
  })
})

describe('filterUsageRecords + summarizeUsage', () => {
  const day = (d: number, hour: number) => new Date(2026, 8, d, hour).getTime()

  const records: UsageRecord[] = [
    record({ timestamp: day(28, 9), modelId: 'model-a', inputTokens: 100, outputTokens: 50 }),
    record({ timestamp: day(29, 9), modelId: 'model-a', inputTokens: 200, outputTokens: 80 }),
    record({ timestamp: day(29, 10), modelId: 'model-b', inputTokens: 10, outputTokens: 5 }),
    record({ timestamp: day(30, 8), modelId: 'model-b', inputTokens: 20, outputTokens: 10 }),
    // 范围外：27 号与未来
    record({ timestamp: day(27, 9), modelId: 'model-a', inputTokens: 999, outputTokens: 999 }),
    record({ timestamp: day(30, 23), modelId: 'model-a', inputTokens: 1, outputTokens: 1 })
  ]

  const range: Parameters<typeof filterUsageRecords>[1] = {
    start: new Date(2026, 8, 28, 0, 0, 0).getTime(),
    end: new Date(2026, 8, 30, 12, 0, 0).getTime()
  }

  it('过滤含端边界', () => {
    const filtered = filterUsageRecords(records, range)
    expect(filtered).toHaveLength(4)
  })

  it('聚合：总量、按日排序、按模型按 tokens 降序', () => {
    const summary = summarizeUsage(records, range)
    expect(summary.requests).toBe(4)
    expect(summary.inputTokens).toBe(330)
    expect(summary.outputTokens).toBe(145)
    expect(summary.days.map((bucket) => bucket.date)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30'])
    expect(summary.byModel[0].modelId).toBe('model-a')
    expect(summary.byModel[0].inputTokens).toBe(300)
    expect(summary.byModel[1].modelId).toBe('model-b')
  })

  it('空范围 → 全零且无桶', () => {
    const summary = summarizeUsage(records, { start: 1, end: 2 })
    expect(summary.requests).toBe(0)
    expect(summary.days).toEqual([])
    expect(summary.byModel).toEqual([])
  })
})
