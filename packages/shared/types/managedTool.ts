// fork 移植自 cherry-studio v2 src/shared/types/managedTool.ts（2026-09-24，逐字）。

export type ManagedToolStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface ManagedToolStatusState {
  status: ManagedToolStatus
  url?: string
}
