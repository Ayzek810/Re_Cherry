import type { ToolMessageBlock } from '@renderer/types/newMessage'

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
 * Tool approval has been removed alongside the MCP/Agent subsystems.
 * This stub returns a neutral state so existing rendering stays intact.
 */
export function useToolApproval(
  block: ToolMessageBlock,
  options: UseToolApprovalOptions = {}
): ToolApprovalState & ToolApprovalActions {
  void block
  void options
  return {
    isWaiting: false,
    isExecuting: false,
    isSubmitting: false,
    confirm: () => {},
    cancel: () => {}
  }
}
