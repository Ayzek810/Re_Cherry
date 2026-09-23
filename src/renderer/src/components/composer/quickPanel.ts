import type React from 'react'

// fork 缝：V2 `components/composer/quickPanel.ts` 的类型子集（V2 该模块是 TipTap 建议
// 插件与本面板桥，fork 无 TipTap）。这里只留 `ComposerSurface` 暴露给调用方的两个句柄：
// `QuickPanelInputAdapter`（面板回写输入）与 `ComposerUnifiedPanelControl`（外部开面板）。
export interface QuickPanelInputAdapter {
  /** 当前编辑器文本与光标位置 —— 面板据此定位触发区间。 */
  getInputState?: () => { text: string; position: number } | undefined
  /** 面板选中项后回写文本（替换 `range` 区间；省略 range = 追加到末尾）。 */
  insertText?: (text: string, range?: { start: number; end: number }) => void
}

export interface ComposerUnifiedPanelControl {
  /** 该作曲条是否接入了统一面板（`quickPanelEnabled`）。 */
  available: boolean
  /** 外部开面板（工具栏按钮等）。 */
  open: (options?: { launcherId?: string; searchText?: string }) => void
}

export type ComposerUnifiedPanelSelectHandler = (
  launcher: ComposerToolLauncher,
  options: { source: ComposerToolLauncherSource; searchText?: string }
) => void

export interface ComposerToolLauncherActionOptions {
  inputAdapter?: QuickPanelInputAdapter
  searchText?: string
  source: ComposerToolLauncherSource
}

export type ComposerToolLauncherKind = 'command' | 'panel' | 'dialog' | 'group'

export type ComposerToolLauncherSource = 'popover' | 'root-panel'

/** V2 `toolLauncher.ts:24-63` 的字段子集：fork 缝里没有工具注册表，只留被传递的形状。 */
export interface ComposerToolLauncher {
  id: string
  kind: ComposerToolLauncherKind
  sources?: readonly ComposerToolLauncherSource[]
  order?: number
  label: React.ReactNode | string
  description?: React.ReactNode | string
  icon: React.ReactNode | string
  disabled?: boolean
  hidden?: boolean
  action?: (options: ComposerToolLauncherActionOptions) => void
}
