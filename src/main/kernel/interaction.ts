/**
 * 审批与问答的宿主接线（内核-插件兼容契约第 3 节可扩展点的消费者）。
 *
 * - `approval/request` waterfall 上挂 answerer：把请求帧推给渲染层，等回执再唤醒内核；
 *   不 claim 就 `next()` 交给后续 answerer，无人应答时由审批服务 fail-closed（'unavailable'）。
 * - `ctx.userQuestions.registerProvider`：ask_user_question 工具的答案同路往返。
 * - 未决请求在内核停机时统一作废（回执 'cancelled' / 直接抛出），不让 agent 回合挂死。
 *
 * 本模块不做业务判断（档位、免审批清单都是后续配置插件的职责），只做"请求帧 ↔ 回执"的搬运。
 */
import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 类型副作用导入：加载 approval/request waterfall 事件的声明合并（否则 ctx.on 无法命名该事件）
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  KernelApprovalDecisionPayload,
  KernelQuestionAnswerPayload
} from '@shared/interaction/types'
import { loggerService } from '@logger'

const logger = loggerService.withContext('KernelInteraction')

interface PendingDecision {
  topicId: string
  resolve: (outcome: 'allowed-once' | 'rejected') => void
}

interface PendingAnswers {
  topicId: string
  resolve: (answers: KernelQuestionAnswerPayload['answers']) => void
}

export class KernelInteractionHub {
  private readonly approvals = new Map<string, PendingDecision>()
  private readonly questions = new Map<string, PendingAnswers>()

  constructor(private readonly push: (payload: unknown) => void) {}

  /** 审批 answerer：返回 undefined = 不 claim（走 next()）。 */
  async handleApprovalRequest(req: {
    agent: Agent
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | undefined> {
    const requestId = randomUUID()
    const topicId = String(req.agent.id)
    const payload = {
      requestId,
      topicId,
      toolName: req.toolName,
      ...(req.callId !== undefined ? { callId: String(req.callId) } : {}),
      ...(req.reason !== undefined ? { reason: req.reason } : {})
    }
    try {
      return await new Promise<'allowed-once' | 'rejected'>((resolve) => {
        this.approvals.set(requestId, { topicId, resolve })
        const onAbort = (): void => {
          // 服务侧已按 signal 把结果定为 'cancelled'；这里只负责回收未决项，回执被丢弃
          if (this.approvals.delete(requestId)) {
            resolve('rejected')
          }
        }
        req.signal?.addEventListener('abort', onAbort, { once: true })
        logger.info(`interaction: approval requested for "${req.toolName}" in topic "${topicId}"`)
        this.push({ kind: 'approval', payload })
      })
    } finally {
      this.approvals.delete(requestId)
    }
  }

  /** userQuestions provider：推问题帧给渲染层，等用户作答。 */
  async ask(request: {
    agent?: Agent
    signal?: AbortSignal
    questions: unknown[]
    callId?: string
  }): Promise<KernelQuestionAnswerPayload['answers']> {
    const requestId = randomUUID()
    const topicId = request.agent !== undefined ? String(request.agent.id) : ''
    if (topicId.length === 0) {
      throw new Error('interaction: question request without an owning agent')
    }
    const payload = {
      requestId,
      topicId,
      ...(request.callId !== undefined ? { callId: String(request.callId) } : {}),
      questions: request.questions
    }
    try {
      return await new Promise<KernelQuestionAnswerPayload['answers']>((resolve) => {
        this.questions.set(requestId, { topicId, resolve })
        const onAbort = (): void => {
          // 工具侧信号中断：回收未决项。ask_user_question 会把中断作为工具错误上报
          if (this.questions.delete(requestId)) {
            resolve([])
          }
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        logger.info(`interaction: question requested in topic "${topicId}"`)
        this.push({ kind: 'question', payload })
      })
    } finally {
      this.questions.delete(requestId)
    }
  }

  /** 渲染层的审批回执。未知 requestId 忽略（迟到的回执/已作废的请求）。 */
  decideApproval(decision: KernelApprovalDecisionPayload): boolean {
    const pending = this.approvals.get(decision.requestId)
    if (pending === undefined) {
      logger.warn(`interaction: approval decision for unknown request "${decision.requestId}"`)
      return false
    }
    this.approvals.delete(decision.requestId)
    pending.resolve(decision.behavior === 'allow' ? 'allowed-once' : 'rejected')
    return true
  }

  /** 渲染层的问答回执。 */
  answerQuestion(answer: KernelQuestionAnswerPayload): boolean {
    const pending = this.questions.get(answer.requestId)
    if (pending === undefined) {
      logger.warn(`interaction: question answer for unknown request "${answer.requestId}"`)
      return false
    }
    this.questions.delete(answer.requestId)
    pending.resolve(answer.answers)
    return true
  }

  /** 内核停机：作废全部未决请求（审批回 'rejected' 由服务转 cancelled；问答直接失败）。 */
  disposeAll(): void {
    for (const [requestId, pending] of [...this.approvals]) {
      this.approvals.delete(requestId)
      pending.resolve('rejected')
    }
    for (const [requestId, pending] of [...this.questions]) {
      this.questions.delete(requestId)
      pending.resolve([])
    }
  }
}

interface UserQuestionsHost {
  registerProvider: (provider: {
    ask: (request: {
      agent?: Agent
      signal?: AbortSignal
      questions: unknown[]
      /** fork 扩展（上游工具变体注入）：发起问答的工具调用 id，帧里带给渲染层配对工具卡。 */
      callId?: string
    }) => Promise<{
      answers: KernelQuestionAnswerPayload['answers']
    }>
  }) => () => void
}

/** 装配审批 answerer 与问答 provider（幂等保护由 cordis effect 与审批服务自身承担）。 */
export function registerInteractionHost(ctx: Context, push: (payload: unknown) => void): KernelInteractionHub {
  const hub = new KernelInteractionHub(push)

  ctx.on('approval/request', async (req, next) => {
    const outcome = await hub.handleApprovalRequest(req)
    if (outcome !== undefined) return outcome
    return next()
  })

  const questions = (ctx as unknown as { userQuestions: UserQuestionsHost }).userQuestions
  if (questions === undefined) {
    throw new Error('kernel: ctx.userQuestions not registered (dsh-user-questions missing)')
  }
  questions.registerProvider({
    // dsh 的 provider 契约返回 { answers }；hub 内部只搬运数组
    ask: async (request) => ({ answers: await hub.ask(request) })
  })

  return hub
}
