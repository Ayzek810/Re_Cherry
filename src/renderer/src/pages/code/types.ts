// fork 移植自 cherry-studio v2 src/renderer/pages/code/types.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：VersionStatus 的 applicationStatus/operation 面按 fork BinaryManager 快照子集收窄——
// V2 为 BinaryApplication/BinaryOperation 对象（src/shared/types/binary.ts，fork 不建该
// shared 文件，fork 快照 application 为扁平状态串且无 operation 广播面）。
// 批次4b 回挂：CodeToolMeta 按 V2 原文补齐（icon 面 = components/CliIcon 的 IconComponent 替身）。

import type { CodeCli } from '@shared/types/codeCli'

import type { IconComponent } from './components/CliIcon'

export interface CodeToolMeta {
  id: CodeCli
  label: string
  icon: IconComponent | null | undefined
}

/** Install/upgrade status for a single CLI tool binary. */
export interface VersionStatus {
  installed: boolean
  source: 'managed' | 'system' | 'none'
  /** Exact-backend-application status; drives update/uninstall/repair authority. */
  applicationStatus?: 'applied' | 'broken' | 'absent'
  systemPath?: string
  current?: string
  latest?: string
  canUpgrade: boolean
}
