import type { ManagedToolStatusState } from '@shared/types/managedTool'

import { useDeepSeekHarnessStatus } from './useCodeCliStatus'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useManagedToolStatus.ts
//（2026-09-24，v0.3.4-1 批次4a）。fork 缝：openclaw 臂（useSharedCacheValue('feature.openclaw.
// gateway_status') + openclaw.get_status 探测）随 useOpenClawGatewayController 一并删除
//（openclaw 未移植）；deepseek 臂的 shared-cache 读取换用 useCodeCliStatus 订阅缝，状态形状
// 与"主推送为单一真源"语义逐字。

export type ManagedTool = 'deepseek-harness'

const STOPPED: ManagedToolStatusState = { status: 'stopped' }

/**
 * Reads the main-owned status snapshot.
 */
export function useManagedToolStatus(_tool: ManagedTool, enabled: boolean): ManagedToolStatusState {
  const deepSeek = useDeepSeekHarnessStatus()
  if (!enabled) return STOPPED
  return deepSeek ?? STOPPED
}
