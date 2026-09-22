/**
 * v0.3.2 新增（fork 自有切片）：已安装技能的渲染层状态。
 * V1 的技能真源在主进程 SQLite（agents 子系统），fork 无该子系统——批次1 由本切片承载 UI 状态，
 * 批次5 接线时若改为磁盘目录扫描为真源，本切片降级为缓存投影（届时同步更新本注释）。
 */
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { InstalledSkill } from '@renderer/types'

export interface SkillsState {
  installedSkills: InstalledSkill[]
}

const initialState: SkillsState = {
  installedSkills: []
}

const skillsSlice = createSlice({
  name: 'skills',
  initialState,
  reducers: {
    setInstalledSkills: (state, action: PayloadAction<InstalledSkill[]>) => {
      state.installedSkills = action.payload
    },
    addInstalledSkill: (state, action: PayloadAction<InstalledSkill>) => {
      const index = state.installedSkills.findIndex((skill) => skill.id === action.payload.id)
      if (index === -1) {
        state.installedSkills.push(action.payload)
      } else {
        state.installedSkills[index] = action.payload
      }
    },
    removeInstalledSkills: (state, action: PayloadAction<string[]>) => {
      const ids = new Set(action.payload)
      state.installedSkills = state.installedSkills.filter((skill) => !ids.has(skill.id))
    }
  }
})

export const { setInstalledSkills, addInstalledSkill, removeInstalledSkills } = skillsSlice.actions

export default skillsSlice.reducer
