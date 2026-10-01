/**
 * 用量记录存储（v0.4.7 用量统计面板）：Dexie usage_records 表（v18 起用）的读写薄封装。
 * 纯聚合在 services/usageStats.ts（可独立测试）；本文件只做 I/O 与边界。
 *
 * 失败语义（v1 二轮审查 s2-06）：读取失败**不能**返回 `summarizeUsage([], range)` ——
 * 那是合法的「空汇总」，UI 会把它渲染成「0 用量 + 暂无数据」这张权威报表，用户据此
 * 认为统计坏了却找不到原因。这里返回判别式结果，让调用方能区分「失败」与「真的 0」。
 */
import { db } from '@renderer/databases'
import { loggerService } from '@renderer/services/LoggerService'
import type { UsageRange, UsageRecord, UsageSummary } from '@renderer/services/usageStats'
import { summarizeUsage } from '@renderer/services/usageStats'
import { safeToString } from '@renderer/utils/error'

const logger = loggerService.withContext('UsageStore')

/** 回合收尾落一条记录；失败只记日志（统计是 best-effort 分析数据，不打扰对话）。 */
export async function recordUsage(entry: Omit<UsageRecord, 'id'>): Promise<void> {
  try {
    await db.usage_records.add(entry as UsageRecord)
  } catch (error) {
    logger.warn('usageStore: failed to record usage', error as Error)
  }
}

export type UsageQueryResult = { ok: true; summary: UsageSummary } | { ok: false; error: string }

/**
 * 读取并聚合一个时间范围的用量。
 *
 * @returns `{ ok: true, summary }` 或 `{ ok: false, error }`；本函数不 reject。
 *   `ok: false` 时的 `summary` 不存在，调用方不得把它当作 0 用量渲染。
 */
export async function queryUsage(range: UsageRange): Promise<UsageQueryResult> {
  try {
    const records = await db.usage_records.where('timestamp').between(range.start, range.end, true, true).toArray()
    // r2-56：`between(..., true, true)` 已按同一闭区间筛过，聚合不必再整表判定一遍。
    return { ok: true, summary: summarizeUsage(records, range, true) }
  } catch (error) {
    logger.error('usageStore: failed to query usage', error as Error)
    return { ok: false, error: error instanceof Error ? error.message : safeToString(error) }
  }
}
