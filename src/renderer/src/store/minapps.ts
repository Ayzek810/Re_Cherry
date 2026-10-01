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
import { allMinApps } from '@renderer/config/minapps'
import type { MinAppType } from '@renderer/types'

export interface MinAppsState {
  enabled: MinAppType[]
  disabled: MinAppType[]
  pinned: MinAppType[]
}

const initialState: MinAppsState = {
  // `allMinApps` 是 `config/minapps.ts` 的模块数组。别名进初值会让「store 状态」与
  // 「配置模板」共用一个数组与同一批元素对象——migrate 的 addMiniApp 与任何就地写入都会串到
  // 模板上（removeMiniAppIconsFromState 之所以克隆元素，正是绕这个坑）。初值处浅拷贝。
  enabled: allMinApps.map((app) => ({ ...app })),
  disabled: [],
  pinned: []
}

const minAppsSlice = createSlice({
  name: 'minApps',
  initialState,
  reducers: {
    setMinApps: (state, action: PayloadAction<MinAppType[]>) => {
      state.enabled = action.payload.map((app) => ({ ...app, logo: undefined }))
    },
    setDisabledMinApps: (state, action: PayloadAction<MinAppType[]>) => {
      state.disabled = action.payload.map((app) => ({ ...app, logo: undefined }))
    },
    setPinnedMinApps: (state, action: PayloadAction<MinAppType[]>) => {
      state.pinned = action.payload.map((app) => ({ ...app, logo: undefined }))
    }
  }
})

export const { setMinApps, setDisabledMinApps, setPinnedMinApps } = minAppsSlice.actions

export default minAppsSlice.reducer
