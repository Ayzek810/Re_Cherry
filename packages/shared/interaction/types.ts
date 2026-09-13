/**
 * 工作模式的审批/问答 IPC 载荷（内核 ↔ 渲染进程）。
 * 审批往返：内核把"要不要批准"变成请求帧推给渲染层，等回执再唤醒（fail-closed）。
 * 问答往返：ask_user_question 工具经 ctx.userQuestions 到达这里，等用户作答。
 */

/** 审批请求帧（内核 → 渲染进程）。 */
export interface KernelApprovalRequestPayload {
  /** 宿主自铸的请求 id；回执按它配对。 */
  requestId: string
  /** 发起审批的话题（= 内核 agent 的 sessionId）。 */
  topicId: string
  /** 被审批的工具名（dsh 工具名，如 read / write / pwsh）。 */
  toolName: string
  /** 关联的工具调用（渲染层把它挂到已流式出的工具卡上）。 */
  callId?: string
  /** 请求方的人类可读原因。 */
  reason?: string
}

/** 审批回执（渲染进程 → 内核）。behavior: allow = 'allowed-once'，deny = 'rejected'。 */
export interface KernelApprovalDecisionPayload {
  requestId: string
  behavior: 'allow' | 'deny'
}

/** 问答条目（与 dsh-user-questions 的 AskUserQuestionItem 同构子集）。 */
export interface KernelQuestionItem {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** 问答请求帧（内核 → 渲染进程）。 */
export interface KernelQuestionRequestPayload {
  requestId: string
  topicId: string
  /** 关联的工具调用（渲染层把问答 UI 挂到该工具卡上）。 */
  callId?: string
  questions: KernelQuestionItem[]
}

/** 问答回执条目。 */
export interface KernelQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 问答回执（渲染进程 → 内核）。 */
export interface KernelQuestionAnswerPayload {
  requestId: string
  answers: KernelQuestionAnswerItem[]
}
