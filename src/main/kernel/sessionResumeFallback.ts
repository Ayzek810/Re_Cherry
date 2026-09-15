/**
 * `resume` 失败后的**唯一处置点**：拒绝新建，还是兜底新建。
 *
 * ## 判据 = 持久化里到底有没有这个会话（本地事实），不是 resume 抛了哪种错误
 *
 * 原实现（v0.3.0-1）在这里用错误类型做门控：命中 `SessionFormatUnsupportedError` /
 * `SessionPersistenceCorruptionError` 才拒绝新建。这条判据的鲁棒面**不在本仓库**——上游 dsh
 * 明确声明对磁盘格式无兼容承诺（`dsh-session` 的 `SESSION_FORMAT_VERSION` 钉在 `0`），一旦它
 * 新增第三种失败形态、或改用普通 `Error`，门控就**无声失效**（fail-open），于是在"已有日志的
 * id"上执行 `agents.create()`，最坏情况覆盖用户历史。
 *
 * 换成查 `ctx.sessionPersistence.list()`：
 * - 它是**只读元数据、不解析整份日志**的轻量列举，因此**恰恰能看见那些读不出来的会话**；
 * - 它只返回**已物化**的会话，而 `create()` 允许惰性物化（未追加过事件的会话不在 list 里），
 *   于是"新话题还没发过消息"天然返回"不存在"，与 `resume` 的失败语义一致；
 * - 一次查询同时覆盖"不存在"与"存在但读不出来"，**不需要**知道抛的是哪一种错误。
 *
 * ## fail-closed（硬要求）
 *
 * `list()` 自身失败（持久化层不可用）时**按"存在"处理并抛出**：查不出来就当不存在，正是本次要
 * 消灭的 fail-open。审批链同样是 fail-closed。
 *
 * ## 为什么新建也放在本模块内执行
 *
 * `createFresh` 以闭包传入、并且**只由本模块在确认"库里没有该会话"之后调用**——决定与执行同处
 * 一点，调用方无法绕开判据（注册表、门面、监听器顺序都不构成约束力）。本模块不依赖 cordis 服务，
 * 因此四条分支都能用桩精确验证（见 `__tests__/sessionResumeFallback.test.ts`）。
 *
 * 另：`list()` **只在 resume 失败后**才会被调用，正常发送路径不进这里（`liveHandles` 已缓存存活
 * agent），故不引入热路径开销。
 *
 * 背景与验收标准：`report.md` §2（v0.3.0-2 目标 A）。
 */
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { loggerService } from '@logger'

import { classifySessionReadFailure } from './sessionReadFailure'

const logger = loggerService.withContext('KernelSessionResume')

/** {@link resumeOrCreateSession} 的入参：能力以闭包传入，避免本模块依赖 cordis 服务。 */
export interface ResumeOrCreateOptions {
  /** 本话题的会话 id（= 话题 id 的品牌化形式）。 */
  sessionId: SessionId
  /** 话题 id，仅用于日志。 */
  topicId: string
  /** 轻量列出已物化会话（只读元数据）。失败即视为"无法确认"，按存在处理。 */
  listPersisted: () => Promise<readonly { readonly id: SessionId }[]>
  /** 从持久化恢复既有会话。 */
  resume: () => Promise<AgentHandle>
  /** 兜底新建空会话。**只在确认库里没有该会话时**才会被调用。 */
  createFresh: () => Promise<AgentHandle>
}

/**
 * 恢复会话；只有确认"持久化里没有这个会话"时才兜底新建。
 *
 * 失败方向是保守的：无法确认（`list()` 抛错）与已持久化，都**拒绝新建并抛出**。
 * @param options - 能力闭包与上下文（见 {@link ResumeOrCreateOptions}）。
 * @returns 恢复出的句柄，或兜底新建出的句柄。
 * @throws 原样上抛 `resume()` 的错误（已持久化时）或 `listPersisted()` 的错误（无法确认时）。
 */
export async function resumeOrCreateSession(options: ResumeOrCreateOptions): Promise<AgentHandle> {
  const { sessionId, topicId, listPersisted, resume, createFresh } = options

  let cause: unknown
  try {
    return await resume()
  } catch (error) {
    cause = error
  }

  let persisted: readonly { readonly id: SessionId }[]
  try {
    persisted = await listPersisted()
  } catch (listError) {
    logger.error(
      `kernel: cannot confirm whether session "${topicId}" is persisted; refusing to create a fresh session over it`,
      listError instanceof Error ? listError : new Error(String(listError))
    )
    throw listError
  }

  if (persisted.some((header) => header.id === sessionId)) {
    // 诊断分类只进日志，不参与决定——判据已由上面的 list() 给出（见 sessionReadFailure.ts）。
    const kind = classifySessionReadFailure(cause)
    logger.error(
      `kernel: session "${topicId}" is persisted but could not be resumed [${kind}]; refusing to create a fresh session over it`,
      cause instanceof Error ? cause : new Error(String(cause))
    )
    throw cause
  }

  logger.warn(
    `kernel: resume session "${topicId}" failed and nothing is persisted, creating fresh`,
    cause instanceof Error ? cause : new Error(String(cause))
  )
  return await createFresh()
}
