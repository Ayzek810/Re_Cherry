/**
 * ask_user_question 往返的渲染侧状态：内核问题请求帧 → 这里挂起 → 工具卡内的问答 UI 作答 →
 * 回执经 IPC 发回内核。历史问答不进这个状态（工具卡直接从块数据渲染参数与结果文本）。
 */
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'

import type { KernelQuestionRequestPayload } from '@shared/interaction/types'

export type UserQuestionEntry = KernelQuestionRequestPayload

export interface UserQuestionsState {
  pending: Record<string, UserQuestionEntry>
}

const initialState: UserQuestionsState = {
  pending: {}
}

const userQuestionsSlice = createSlice({
  name: 'userQuestions',
  initialState,
  reducers: {
    requestReceived: (state, action: PayloadAction<UserQuestionEntry>) => {
      state.pending[action.payload.requestId] = action.payload
    },
    requestAnswered: (state, action: PayloadAction<{ requestId: string }>) => {
      delete state.pending[action.payload.requestId]
    },
    /** 回合结束/话题删除时作废该话题的未决问题（abort 路径的兜底清理）。 */
    clearByTopic: (state, action: PayloadAction<{ topicId: string }>) => {
      for (const [key, entry] of Object.entries(state.pending)) {
        if (entry.topicId === action.payload.topicId) {
          delete state.pending[key]
        }
      }
    },
    clearAll: (state) => {
      state.pending = {}
    }
  }
})

export const userQuestionsActions = userQuestionsSlice.actions

export default userQuestionsSlice.reducer
