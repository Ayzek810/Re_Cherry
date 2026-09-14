/**
 * 区分「会话日志**存在但读不出来**」与「会话不存在」——供 resume 兜底做数据安全判定。
 *
 * ## 为什么需要这个判别
 *
 * `topics.ts` 的 `ensureAgent`（以及 dsh 侧的同款兜底思路）在 `ctx.agents.resume()` 失败时会
 * **用同一个 sessionId 新建空会话**。这在"会话确实不存在"（例如库里被清过）时是合理的健壮性设计，
 * 但在"**日志存在、只是本构建读不出来**"时是危险的：用同一 id 新建会**掩盖**问题，最坏情况是
 * 覆盖用户历史。v0.3.0-1 实测到的遗留 `cherry/work-mode` 会话正是这一类（218 条事件的日志在库里，
 * resume 必然抛 `SessionFormatUnsupportedError`）。
 *
 * ## 为什么用类型判别而不是消息匹配
 *
 * dsh 对"会话不存在"抛的是**普通 `Error`**（消息形如 `session "x" not found`，位于
 * `dsh-session-persistence` 的 coordinator，没有类型化 code），而对上面两类危险失败抛的是
 * **具名导出类**：`SessionFormatUnsupportedError` / `SessionPersistenceCorruptionError`。
 * 因此**只对危险的一侧做类型判别**即可：命中即拒绝新建；其余（含"不存在"）保持既有兜底行为。
 * 这样不依赖任何**消息文本**（消息会随内核升级变化），只依赖公开导出的类。
 *
 * 类同一性前提：已在本仓库的 pnpm 布局下验证——fork 顶层 import 与
 * `dsh-session-persistence-sqlite` 内部解析到的是**同一个类对象**，故 `instanceof` 可靠。
 */
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'

/**
 * 该错误是否表示「会话日志存在但本构建无法忠实解释」（格式不受支持 / 日志已损坏）。
 * @param error - resume / load 抛出的任意值。
 * @returns true 表示**不得**用同一 id 新建会话。
 */
export function isUnreadableSessionError(error: unknown): boolean {
  return error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError
}
