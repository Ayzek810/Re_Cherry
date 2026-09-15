/**
 * 会话读取失败的**诊断分类**——把 `resume` / `load` 的错误分成三类记入日志，便于真机判断故障形态。
 *
 * ## 它不承担安全职责（v0.3.0-2 起）
 *
 * 本模块**不得**用于决定"resume 失败后要不要用同一 id 新建会话"。那条决定的安全判据是
 * `sessionResumeFallback.ts` 里的**持久化存在性查询**（`ctx.sessionPersistence.list()`）：
 * 错误分类依赖上游内核的抛错行为（dsh 对磁盘格式无兼容承诺，新增第三种形态或用普通 `Error`
 * 都会让分类**无声失效**，即 fail-open），而"库里到底有没有这一行"是本机事实。
 * 因此本模块的返回值**只用于日志分组**——不要把 `!== 'unclassified'` 之类当成放行条件。
 *
 * ## 三类
 *
 * - `format-unsupported`：`SessionFormatUnsupportedError`——日志在库里，但含本构建不认识的事件
 *   类型且未标 `ignorable`（v0.3.0-1 实测到的遗留 `cherry/work-mode` 会话即此类）。
 * - `corrupted`：`SessionPersistenceCorruptionError`——日志本身损坏（例如 `ignorable` 字段非法）。
 * - `unclassified`：其余一切，含 dsh 对"会话不存在"抛的普通 `Error`（`session "x" not found`，
 *   没有类型化 code）。**注意**：`unclassified` 不等于"不存在"。
 *
 * ## 为什么用类型判别而不是消息匹配
 *
 * 上述两类危险失败是 dsh **公开导出的具名类**，而"会话不存在"只是一条**消息文本**。因此判别只认
 * 类、不认文本（消息会随内核升级变化）。类同一性前提：已在本仓库的 pnpm 布局下验证——fork 顶层
 * import 与 `dsh-session-persistence-sqlite` 内部解析到的是**同一个类对象**，故 `instanceof` 可靠。
 */
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'

/** {@link classifySessionReadFailure} 的三值分类。 */
export type SessionReadFailureKind = 'format-unsupported' | 'corrupted' | 'unclassified'

/**
 * 把一次会话读取失败归类，供日志写清故障形态。
 * @param error - `resume` / `load` 抛出的任意值。
 * @returns 三值分类；返回 `'unclassified'` **不**表示"会话不存在"，也不得作为新建会话的依据。
 */
export function classifySessionReadFailure(error: unknown): SessionReadFailureKind {
  if (error instanceof SessionFormatUnsupportedError) return 'format-unsupported'
  if (error instanceof SessionPersistenceCorruptionError) return 'corrupted'
  return 'unclassified'
}
