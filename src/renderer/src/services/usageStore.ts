/**
 * 用量记录存储（v0.4.7 用量统计面板）：Dexie usage_records 表（v18 起用）的读写薄封装。
 * 纯聚合在 services/usageStats.ts（可独立测试）；本文件只做 I/O 与边界（静默失败要
 * 有日志——CLAUDE.md「 Silent failure is forbidden」）。
 */
import { db } from '@renderer/databases'
import { loggerService } from '@renderer/services/LoggerService'
import type { UsageRange, UsageRecord, UsageSummary } from '@renderer/services/usageStats'
import { summarizeUsage } from '@renderer/services/usageStats'

const logger = loggerService.withContext('UsageStore')

/** 回合收尾落一条记录；失败只记日志（统计是 best-effort 分析数据，不打扰对话）。 */
export async function recordUsage(entry: Omit<UsageRecord, 'id'>): Promise<void> {
  try {
    await db.usage_records.add(entry as UsageRecord)
  } catch (error) {
    logger.warn('usageStore: failed to record usage', error as Error)
  }
}

export async function queryUsage(range: UsageRange): Promise<UsageSummary> {
  try {
    const records = await db.usage_records.where('timestamp').between(range.start, range.end, true, true).toArray()
    return summarizeUsage(records, range)
  } catch (error) {
    logger.warn('usageStore: failed to query usage', error as Error)
    return summarizeUsage([], range)
  }
}
