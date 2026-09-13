import { DEFAULT_ASSISTANT_WORK_MODE } from '@renderer/services/AssistantService'
import type { Assistant, AssistantWorkModeConfig } from '@renderer/types'
import type { WorkModeApprovalTier } from '@shared/config/workMode'
import { WORK_MODE_APPROVAL_TIERS } from '@shared/config/workMode'

/** 工作模式审批三档的静态 i18n 键（全字面量，避免模板键进入 i18n 动态键审计）。 */
export const WORK_MODE_TIER_I18N: Record<WorkModeApprovalTier, { title: string; description: string }> = {
  'danger-full-access': {
    title: 'settings.agentSettings.permissionMode.tiers.danger-full-access.title',
    description: 'settings.agentSettings.permissionMode.tiers.danger-full-access.description'
  },
  'read-only': {
    title: 'settings.agentSettings.permissionMode.tiers.read-only.title',
    description: 'settings.agentSettings.permissionMode.tiers.read-only.description'
  },
  'workspace-write': {
    title: 'settings.agentSettings.permissionMode.tiers.workspace-write.title',
    description: 'settings.agentSettings.permissionMode.tiers.workspace-write.description'
  }
}

/** 三档展示顺序（从最保守到最宽松）。 */
export const WORK_MODE_TIER_ORDER: readonly WorkModeApprovalTier[] = WORK_MODE_APPROVAL_TIERS

/** 合并助手工作模式配置（老助手无 workMode 字段时以默认值兜底）。 */
export function mergeWorkMode(assistant: Assistant, patch: Partial<AssistantWorkModeConfig>): AssistantWorkModeConfig {
  return { ...DEFAULT_ASSISTANT_WORK_MODE, ...assistant.workMode, ...patch }
}
