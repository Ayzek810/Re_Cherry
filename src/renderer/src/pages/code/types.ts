// fork 移植自 cherry-studio v2 src/renderer/pages/code/types.ts（2026-09-24）。
// fork 缝：VersionStatus 的 applicationStatus/operation 面按 fork BinaryManager 快照子集收窄——
// V2 为 BinaryApplication/BinaryOperation 对象（src/shared/types/binary.ts，fork 不建该
// shared 文件，fork 快照 application 为扁平状态串且无 operation 广播面）。
// 回挂：CodeToolMeta 按 V2 原文补齐（icon 面 = components/CliIcon 的 IconComponent 替身）。

import type { CodeCli } from '@shared/types/codeCli'
import type { InstallProgressPayload } from '@shared/types/installProgress'

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
  /**
   * （）：主进程记录的上次安装/升级失败原因。版本卡的失败行据此持久显示
   * （刷新/重启后仍在）——此前失败原因只活在一次 toast 里。
   */
  lastFailure?: string
  /**
   * v1（W4-4）：主进程正在进行的操作（随快照下发）。页面重挂载后据此恢复"正在安装/卸载"，
   * 不再依赖组件局部 busy 集合（切页即销毁，进度看起来就"丢了"）。
   */
  operation?: {
    kind: 'install' | 'remove'
    at: number
    progress?: InstallProgressPayload
  }
}
