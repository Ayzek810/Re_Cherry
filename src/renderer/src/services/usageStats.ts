/**
 * 用量统计聚合（用量统计面板的纯函数层）。
 *
 * 数据模型：一次回合 = 一条 UsageRecord（kernelChat 回合收尾处落库；本地记录是
 * 内核会话日志中 usage 事件的派生分析数据，不是会话状态的第二真相源——不变量2
 * 允许派生分析库存在，就像 trace/span 一样）。
 * 聚合：时间范围过滤 → 总量 + 按日桶（本地时区 YYYY-MM-DD）+ 按模型桶，全部纯函数。
 */
import type { UsageRecord } from '@renderer/types'

export type { UsageRecord } from '@renderer/types'

export interface UsageDayBucket {
  /** 本地时区 YYYY-MM-DD。 */
  date: string
  requests: number
  inputTokens: number
  outputTokens: number
}

export interface UsageModelBucket {
  modelId: string
  requests: number
  inputTokens: number
  outputTokens: number
}

export interface UsageSummary {
  requests: number
  inputTokens: number
  outputTokens: number
  days: UsageDayBucket[]
  byModel: UsageModelBucket[]
}

export interface UsageRange {
  /** 含端（epoch ms）。 */
  start: number
  /** 含端（epoch ms）。 */
  end: number
}

export function usageRangeForPreset(preset: 'today' | '7d' | '30d' | 'all', now: number = Date.now()): UsageRange {
  const end = now
  if (preset === 'all') return { start: 0, end }
  const days = preset === 'today' ? 1 : preset === '7d' ? 7 : 30
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return { start: start.getTime(), end }
}

export function filterUsageRecords(records: UsageRecord[], range: UsageRange): UsageRecord[] {
  return records.filter((record) => record.timestamp >= range.start && record.timestamp <= range.end)
}

/** 本地时区日期键（不是 UTC——"今天"按用户墙上的日子算）。 */
export function usageDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function emptyDayBucket(date: string): UsageDayBucket {
  return { date, requests: 0, inputTokens: 0, outputTokens: 0 }
}

function emptyModelBucket(modelId: string): UsageModelBucket {
  return { modelId, requests: 0, inputTokens: 0, outputTokens: 0 }
}

/**
 * 聚合一批用量记录。
 *
 * @param records 记录集合。
 * @param range 时间范围（用于按天分桶的边界语义）。
 * @param alreadyFiltered ：调用方已用 `between(start, end, true, true)` 按**同一闭区间**
 *   取过数时传 `true`，跳过 `filterUsageRecords` 的整表 O(n) 二次判定（否则随表增长白白翻倍）。
 *   默认 `false`，语义与既有调用方逐字一致。
 */
export function summarizeUsage(records: UsageRecord[], range: UsageRange, alreadyFiltered = false): UsageSummary {
  const filtered = alreadyFiltered ? records : filterUsageRecords(records, range)
  const dayMap = new Map<string, UsageDayBucket>()
  const modelMap = new Map<string, UsageModelBucket>()
  let requests = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const record of filtered) {
    requests += 1
    inputTokens += record.inputTokens
    outputTokens += record.outputTokens

    const dateKey = usageDateKey(record.timestamp)
    const day = dayMap.get(dateKey) ?? emptyDayBucket(dateKey)
    day.requests += 1
    day.inputTokens += record.inputTokens
    day.outputTokens += record.outputTokens
    dayMap.set(dateKey, day)

    const model = modelMap.get(record.modelId) ?? emptyModelBucket(record.modelId)
    model.requests += 1
    model.inputTokens += record.inputTokens
    model.outputTokens += record.outputTokens
    modelMap.set(record.modelId, model)
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const byModel = [...modelMap.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
  )
  return { requests, inputTokens, outputTokens, days, byModel }
}
