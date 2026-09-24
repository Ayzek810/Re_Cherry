import type { SidebarIcon } from '@renderer/types'

/**
 * 默认显示的侧边栏图标
 * 这些图标会在侧边栏中默认显示
 */
export const DEFAULT_SIDEBAR_ICONS: SidebarIcon[] = [
  'assistants',
  'minapp',
  'files',
  'knowledge',
  'translate',
  'paintings',
  // v0.3.3-2 笔记复活：V1 默认就带这一枚（老用户的持久化由 migrate 的 '141' 分支补）
  'notes'
]
