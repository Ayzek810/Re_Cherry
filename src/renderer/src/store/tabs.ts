/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'

export interface Tab {
  id: string
  path: string
  /**
   * 固定在标签条最左侧（语义对齐 V2 `Tab.isPinned`：固定区恒在普通区之前，
   * 且固定标签页对"关闭其他标签页"豁免）。
   */
  isPinned?: boolean
}

export interface TabsState {
  tabs: Tab[]
  activeTabId: string
}

const initialState: TabsState = {
  tabs: [
    {
      id: 'home',
      path: '/'
    }
  ],
  activeTabId: 'home'
}

/** 首页标签页的固定 id（常驻、不可关；位置恒在最前）。 */
export const HOME_TAB_ID = 'home'

/**
 * 标签条的排序不变式（两层）：
 * 1. **首页恒在第一位**——固定别的标签页不该把首页顶下去（用户点名："我最好确保首页一直在第一个"）；
 * 2. 其余按 V2 语义 `[...pinned, ...normal]`，区内各自保持原相对序。
 */
const pinnedFirst = (tabs: Tab[]): Tab[] => {
  const home = tabs.filter((tab) => tab.id === HOME_TAB_ID)
  const rest = tabs.filter((tab) => tab.id !== HOME_TAB_ID)
  return [...home, ...rest.filter((tab) => tab.isPinned === true), ...rest.filter((tab) => tab.isPinned !== true)]
}

const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    setTabs: (state, action: PayloadAction<Tab[]>) => {
      // 拖拽可以横跨两区，这里把"固定在前"的不变式补回来（区内相对序不变）。
      state.tabs = pinnedFirst(action.payload)
    },
    addTab: (state, action: PayloadAction<Tab>) => {
      const existingTab = state.tabs.find((tab) => tab.path === action.payload.path)
      if (!existingTab) {
        state.tabs.push(action.payload)
      }
      state.activeTabId = action.payload.id
    },
    removeTab: (state, action: PayloadAction<string>) => {
      const index = state.tabs.findIndex((tab) => tab.id === action.payload)
      if (index !== -1) {
        state.tabs.splice(index, 1)
        // 如果关闭的是当前标签页，则切换到最后一个标签页
        if (action.payload === state.activeTabId) {
          state.activeTabId = state.tabs[state.tabs.length - 1].id
        }
      }
    },
    setActiveTab: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload
    },
    /** 固定/取消固定：固定 → 追加到固定区末尾；取消 → 追加到普通区末尾（V2 同）。 */
    toggleTabPin: (state, action: PayloadAction<string>) => {
      const tab = state.tabs.find((candidate) => candidate.id === action.payload)
      if (tab === undefined) return
      const moved: Tab = { ...tab, isPinned: tab.isPinned !== true }
      state.tabs = pinnedFirst([...state.tabs.filter((candidate) => candidate.id !== action.payload), moved])
    },
    /** 关闭其他标签页：固定标签页与**首页**都豁免（V2 同 + 首页常驻），保留目标标签页本身。 */
    closeOtherTabs: (state, action: PayloadAction<string>) => {
      const kept = state.tabs.filter(
        (tab) => tab.id === action.payload || tab.isPinned === true || tab.id === HOME_TAB_ID
      )
      if (kept.length === 0) return
      state.tabs = pinnedFirst(kept)
      if (!kept.some((tab) => tab.id === state.activeTabId)) {
        state.activeTabId = action.payload
      }
    },
    /**
     * 启动时恢复上次会话保留下来的固定标签页（v0.3.3-1 持久化）：已在清单里的只补 `isPinned`，
     * 缺的按记录补回标签条；没有任何变化时**返回原 state**，避免无谓刷新。
     */
    restorePinnedTabs: (state, action: PayloadAction<{ id: string; path: string }[]>) => {
      const saved = action.payload
      if (saved.length === 0) return
      const existingIds = new Set(state.tabs.map((tab) => tab.id))
      const missing = saved.filter((tab) => !existingIds.has(tab.id))
      const needsPinFlag = state.tabs.some(
        (tab) => tab.isPinned !== true && saved.some((savedTab) => savedTab.id === tab.id)
      )
      if (missing.length === 0 && !needsPinFlag) return
      const savedIds = new Set(saved.map((tab) => tab.id))
      const updated = state.tabs.map((tab) =>
        savedIds.has(tab.id) && tab.isPinned !== true ? { ...tab, isPinned: true } : tab
      )
      state.tabs = pinnedFirst([...missing.map((tab) => ({ ...tab, isPinned: true })), ...updated])
    }
  }
})

export const { setTabs, addTab, removeTab, setActiveTab, toggleTabPin, closeOtherTabs, restorePinnedTabs } =
  tabsSlice.actions
export default tabsSlice.reducer
