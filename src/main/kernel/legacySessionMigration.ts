/**
 * 遗留会话事件的 `ignorable` 补标记迁移（v0.3.0-1 后续）。
 *
 * ## 为什么需要它（一条真实断裂）
 *
 * dsh 持久化的读取路径用**硬编码的运行期集合** `KNOWN_SESSION_EVENT_TYPES`
 * （`@deepseek-ai/dsh-session`，源码 `packages/core/session/src/known-event-types.ts`）判定"本构建认识的
 * 事件词汇"；对本构建**不认识**的事件类型，除非该事件信封带 `ignorable: true`，否则**整段日志拒绝解释**，
 * 抛 `SessionFormatUnsupportedError`（`dsh-session-persistence` 的 `assertEventsSupported`）。
 * 上游在该集合的注释里写得很明确：仓库外插件的事件"按构造就不在名单里，注册面推迟到真有消费者时再做"
 * ——也就是说，**fork 侧唯一的合规杠杆就是信封上的 `ignorable` 标记**，没有任何运行期注册 API。
 *
 * v0.2.x 的 `cherry/work-mode` 事件（载荷 `{"active":true}`，每个会话至多 `seq=0` 一条）写入时**没有**
 * 打这个标记。该事件在当前代码里已不再产生（`src/` 全库 grep 0 命中），其语义也早被 `Topic.workMode` 取代。
 * 但后果很重：**只要一个旧会话含这一条事件，整段日志就读不出来**——
 *   - `searchSessions` 走 `ctx.sessionPersistence.inspect` → 抛错 → 捕获后**静默跳过该会话**；
 *   - 打开该话题时 `resume` 同样失败 → 回退分支"creating fresh session"（用户看到的是"聊天记录没了"）。
 *
 * ## 做法
 *
 * 一次**幂等、增量、只放宽**的数据迁移：把该类型行的 `ignorable` 由 `NULL` 置为 `1`。
 * 不改事件内容、不删任何行、不碰其他类型；重复执行无副作用（`WHERE … AND ignorable IS NULL`）。
 * 语义上正确：该事件本来就"可以安全跳过"（它是旧版 UI 开关的标记，当前代码不读它）。
 *
 * ## 为什么单独成文件
 *
 * 契约要求"直连 SQL 不得散落在 IPC/业务层，必须收口"。本模块是 fork 侧**唯一**管辖这类历史数据修正的
 * 地方，与 `topics.ts` 的会话回收/清盘（`ctx.sessionGC`）职责并列但不同类：**迁移 ≠ 清盘**，故不混进清盘路径。
 */
import { join } from 'node:path'

import { loggerService } from '@logger'
import { app } from 'electron'

const logger = loggerService.withContext('KernelLegacyMigration')

/** 写入时漏打 `ignorable` 标记的历史事件类型（对应 v0.2.x 的"工作模式"标记）。 */
const LEGACY_IGNORABLE_EVENT_TYPES = ['cherry/work-mode'] as const

/**
 * 给历史事件补上 `ignorable` 标记，使旧会话重新可读。
 *
 * @returns 实际更新的行数（0 表示无需迁移或迁移失败）
 */
export async function migrateLegacyIgnorableEvents(): Promise<number> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(app.getPath('userData'), 'kernel', 'sessions.db'))
    try {
      // 与 dsh 的持久化连接并存：给它一点忙等窗口，避免启动期偶发 SQLITE_BUSY 让迁移静默失效。
      db.exec('PRAGMA busy_timeout = 5000')
      const placeholders = LEGACY_IGNORABLE_EVENT_TYPES.map(() => '?').join(', ')
      const result = db
        .prepare(`UPDATE events SET ignorable = 1 WHERE type IN (${placeholders}) AND ignorable IS NULL`)
        .run(...LEGACY_IGNORABLE_EVENT_TYPES)
      const changed = Number(result.changes ?? 0)
      if (changed > 0) {
        logger.info(
          `kernel: legacy migration marked ${changed} event(s) ignorable (${LEGACY_IGNORABLE_EVENT_TYPES.join(', ')}) — ` +
            'these logs were previously unreadable (SessionFormatUnsupportedError)'
        )
      }
      return changed
    } finally {
      db.close()
    }
  } catch (error) {
    // 迁移失败不得影响启动：旧会话继续不可读，但新会话一切照常。
    logger.warn(
      'kernel: legacy ignorable migration failed (old sessions may stay unreadable)',
      error instanceof Error ? error : new Error(String(error))
    )
    return 0
  }
}
