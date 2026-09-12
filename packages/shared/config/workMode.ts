/**
 * 工作模式审批档位词汇（与 dsh permission-presets / fs-sandbox 的取值一致，不另造词表）。
 *
 * 三档 = dsh 权限预设（沙箱模式 × 审批策略的组合），与沙箱模式名 1:1：
 * - 'read-only'          每次询问：沙箱只读 + 审批 ask（每个要动手的调用都弹卡等待用户放行）
 * - 'workspace-write'    工作区自动：沙箱工作区可写 + 审批 never（越界由沙箱拦截，不弹卡）
 * - 'danger-full-access' 全部放行：沙箱不设防 + 审批 never
 *
 * 存储值直接使用 dsh 的预设名（即沙箱模式名），Step 3 接入真工具时按此注册预设。
 */
export const WORK_MODE_APPROVAL_TIERS = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type WorkModeApprovalTier = (typeof WORK_MODE_APPROVAL_TIERS)[number]
