/**
 * 应用更新的跨进程契约。
 *
 * 主进程持有状态机并在每次变化后推送；渲染层只读状态、发起动作。
 * 三层（主进程 / preload / 渲染层）引用同一份声明，避免形状漂移。
 */

export type AppUpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'

/** 主进程只回错误码，文案由渲染层按语言映射（主进程不持有用户可见文案）。 */
export type AppUpdateErrorCode =
  | 'network'
  | 'http'
  | 'parse'
  | 'no-asset'
  | 'digest'
  | 'io'
  /** 便携版没有可替换的安装目录，只能引导手动下载。 */
  | 'unsupported'

export interface AppUpdatePrefs {
  /** 更新源。空串表示用主进程的默认源。 */
  sourceUrl: string
  /** 发现新版本就自动开始下载。默认关。 */
  autoDownload: boolean
  /** 被用户忽略的版本号。 */
  ignoredVersion: string | null
}

export interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  latestVersion: string | null
  /** 发布说明**原文**（可能带 `<!--LANG:-->` 分语块），由渲染层按界面语言切段。 */
  releaseNotes: string | null
  releasePageUrl: string | null
  assetName: string | null
  assetSize: number | null
  progress: AppUpdateProgress | null
  /** 该版本被用户忽略：仍报 available，由渲染层决定不提示。 */
  ignored: boolean
  /** 摘要校验结果：null = 源没给摘要，未校验。 */
  verified: boolean | null
  /** 本次检查是否由用户手动触发。 */
  manual: boolean
  errorCode: AppUpdateErrorCode | null
  errorDetail: string | null
}
