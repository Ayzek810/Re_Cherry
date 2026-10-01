// fork 移植自 cherry-studio v2 src/renderer/utils/binarySnapshot.ts（2026-09-24）。
// fork 缝：fork 无 semver 依赖、快照为 V2 子集（src/main/services/binaryManager/BinaryManager.ts
// 抄形状注释：application 为扁平 'applied'|'broken'|'absent'，availability source 为
// managed/system/none，version 随 managed）。接口名与语义面（installed/hasUpdate/
// applicationStatus/exactApplied/…）与 V2 保持一致，消费方无需感知差异；isNewerVersion 以
// 点分数字段比较近似 semver.gt（非语义版本串回退为不等判定），已标缝注。
// v1（W4-4）：`operation`（进行中的安装/卸载）从 V2 的丢弃面恢复——主进程侧同名字段同步进快照，
// 渲染层据此在页面重挂载后恢复"正在安装"，不再依赖组件局部 busy 集合。

import type { InstallProgressPayload } from '@shared/types/installProgress'

export interface BinaryToolSnapshot {
  name: string
  application: 'applied' | 'broken' | 'absent'
  availability:
    | { source: 'managed'; path: string; version?: string }
    | { source: 'system'; path: string }
    | { source: 'none' }
  /**
   * （）：该工具最近一次安装/升级失败的原始原因，由主进程记录并随快照落盘。
   * 版本卡的失败行据此持久显示——此前失败原因只活在一次 toast 里。
   */
  lastFailure?: string
  /**
   * v1（W4-4）：该工具**当前正在跑**的操作（主进程持有，见 BinaryManager 的同名字段）。
   * 渲染层进入页面时以它为准——局部 busy 集合只在本次会话内即时反馈，切页即销毁。
   */
  operation?: {
    kind: 'install' | 'remove'
    at: number
    progress?: InstallProgressPayload
  }
}

/**
 * Normalized, display-ready reading of a raw {@link BinaryToolSnapshot}.
 *
 * Centralizes the rules every management surface needs — which availability
 * source carries a version, which path to show, and whether a managed update
 * exists — so the Dependencies page and the Code CLI page cannot drift in how
 * they interpret a snapshot.
 */
export interface InterpretedBinarySnapshot {
  source: BinaryToolSnapshot['availability']['source']
  /** True when the tool resolves to any concrete source (managed/system). */
  installed: boolean
  /** Version string only when the source actually reports one (managed). */
  installedVersion?: string
  /** Executable path when resolved through the system PATH. */
  systemPath?: string
  /** Executable path for any resolved (non-`none`) source. */
  resolvedPath?: string
  /** The exact-backend-application status main computed, when present. */
  applicationStatus?: BinaryToolSnapshot['application']
  /** True only when the exact managed recipe is applied. */
  exactApplied: boolean
  /** Version carried by the application fact (`applied`/`broken`); absent otherwise. */
  applicationVersion?: string
  /** An exactly-applied tool has a newer managed version available. */
  hasUpdate: boolean
  /** （）：主进程记录的上次安装失败原因（无失败时 undefined）。 */
  lastFailure?: string
  /** v1（W4-4）：主进程正在进行中的操作（无操作时 undefined）。 */
  operation?: BinaryToolSnapshot['operation']
}

export interface InterpretBinarySnapshotOptions {
  /** Latest managed version for this tool, from the latest-versions cache. */
  latest?: string
}

// fork 缝：V2 用 semver（valid + gt）；fork 未安装 semver（本批触碰清单外）。点分数字段
// 比较，任一侧非语义版本（含非数字段）回退为字符串不等判定。
const isNewerVersion = (latest?: string, installed?: string): boolean => {
  if (!latest || !installed) return false
  const latestParts = latest.split('.')
  const installedParts = installed.split('.')
  const isNumeric = (parts: string[]) => parts.every((part) => /^\d+$/.test(part))
  if (!isNumeric(latestParts) || !isNumeric(installedParts)) return latest !== installed
  const length = Math.max(latestParts.length, installedParts.length)
  for (let i = 0; i < length; i++) {
    const a = Number(latestParts[i] ?? 0)
    const b = Number(installedParts[i] ?? 0)
    if (a !== b) return a > b
  }
  return false
}

/** Interpret a raw snapshot into the primitives a management card renders. */
export function interpretBinarySnapshot(
  snapshot: BinaryToolSnapshot | undefined,
  options: InterpretBinarySnapshotOptions = {}
): InterpretedBinarySnapshot {
  const availability = snapshot?.availability ?? { source: 'none' as const }
  const applicationStatus = snapshot?.application
  const exactApplied = applicationStatus === 'applied'
  const applicationVersion =
    applicationStatus === 'applied' || applicationStatus === 'broken'
      ? availability.source === 'managed'
        ? availability.version
        : undefined
      : undefined
  const installedVersion = availability.source === 'managed' ? availability.version : undefined
  return {
    source: availability.source,
    installed: availability.source !== 'none',
    installedVersion,
    systemPath: availability.source === 'system' ? availability.path : undefined,
    resolvedPath: availability.source === 'none' ? undefined : availability.path,
    applicationStatus,
    exactApplied,
    applicationVersion,
    // An update requires the exact recipe to be applied — never a
    // runnable-but-not-applied conflict or an external source.
    hasUpdate: exactApplied && isNewerVersion(options.latest, applicationVersion),
    ...(snapshot?.lastFailure ? { lastFailure: snapshot.lastFailure } : {}),
    ...(snapshot?.operation ? { operation: snapshot.operation } : {})
  }
}
