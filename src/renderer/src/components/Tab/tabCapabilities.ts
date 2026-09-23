/**
 * 标签页右键菜单的可用性规则（V2 `AppShellTabBar.tsx:getTabCapabilities` 的 fork 子集）。
 *
 * 只保留 fork 现有的三项能力：固定/取消固定、关闭其他标签页、关闭本标签页。
 * V2 的 `move_to_first`/`detach`/`close_to_right` 在 fork 没有对应实现，故不在此列。
 *
 * 语义逐条对齐 V2：
 * - 固定标签页可被固定/取消固定，也可单独关闭（行内不渲染 ×，只能走菜单）；
 * - **批量关闭（关闭其他标签页）只作用于普通区**：从固定标签页发起时，只要还有普通标签页就可用；
 *   从普通标签页发起时需要至少还有一个同级普通标签页；
 * - `home` 不可关闭、也不计入"其他普通标签页"（调用方在计数时就要排除它，见 `TabContainer`）。
 */
export interface TabCapabilities {
  togglePin: boolean
  close: boolean
  closeOthers: boolean
}

export function getTabCapabilities(
  tab: { id: string; isPinned?: boolean },
  ctx: { pinnedCount: number; normalCount: number }
): TabCapabilities {
  const isPinned = tab.isPinned === true
  return {
    togglePin: true,
    close: tab.id !== 'home',
    closeOthers: isPinned ? ctx.normalCount > 0 : ctx.normalCount > 1
  }
}
