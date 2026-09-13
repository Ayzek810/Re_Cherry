import { useAppDispatch, useAppSelector } from '@renderer/store'
import { toolPermissionsActions } from '@renderer/store/toolPermissions'
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'

/**
 * Unified tool approval state
 */
export interface ToolApprovalState {
  isWaiting: boolean
  isExecuting: boolean
  isSubmitting: boolean
  input?: Record<string, unknown>
}

/**
 * Unified tool approval actions
 */
export interface ToolApprovalActions {
  confirm: () => void | Promise<void>
  cancel: () => void | Promise<void>
  autoApprove?: () => void | Promise<void>
}

export interface UseToolApprovalOptions {
  forceType?: 'mcp' | 'agent'
}

/**
 * 内核审批往返（v0.3.0 Step 2）：按 callId 配对 toolPermissions 里未决的审批请求，
 * 允许/拒绝经 IPC 发回内核（KernelInteractionHub.decideApproval），内核唤醒后继续回合。
 */
export function useToolApproval(
  block: ToolMessageBlock,
  options: UseToolApprovalOptions = {}
): ToolApprovalState & ToolApprovalActions {
  void options
  const dispatch = useAppDispatch()
  // 投影时 toolId = callId；审批请求按 toolCallId 配对到块
  const entry = useAppSelector((state) =>
    Object.values(state.toolPermissions.requests).find((request) => request.toolCallId === block.toolId)
  )

  const isWaiting = entry?.status === 'pending'
  const isSubmitting = entry?.status === 'submitting-allow' || entry?.status === 'submitting-deny'
  const isExecuting =
    !isWaiting && !isSubmitting && (entry?.status === 'invoking' || block.status === MessageBlockStatus.PROCESSING)

  const decide = async (behavior: 'allow' | 'deny'): Promise<void> => {
    if (entry === undefined) return
    const requestId = entry.requestId
    dispatch(toolPermissionsActions.submissionSent({ requestId, behavior }))
    try {
      const result = (await window.api.dshApprovalDecide({ requestId, behavior })) as { ok: boolean }
      if (result?.ok === true) {
        dispatch(toolPermissionsActions.requestResolved({ requestId, behavior, reason: 'response' }))
      } else {
        // 未知请求（内核已作废/已答）——直接摘除本地未决项
        dispatch(toolPermissionsActions.removeByToolCallId({ toolCallId: entry.toolCallId }))
      }
    } catch {
      dispatch(toolPermissionsActions.submissionFailed({ requestId }))
    }
  }

  return {
    isWaiting,
    isExecuting,
    isSubmitting,
    ...(entry?.resolvedInput !== undefined ? { input: entry.resolvedInput } : {}),
    confirm: () => decide('allow'),
    cancel: () => decide('deny')
  }
}
