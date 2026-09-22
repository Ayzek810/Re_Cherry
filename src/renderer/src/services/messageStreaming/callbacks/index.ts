import type { Assistant } from '@renderer/types'

import type { BlockManager } from '../BlockManager'
import { createBaseCallbacks } from './baseCallbacks'
import { createCompactCallbacks } from './compactCallbacks'
import { createImageCallbacks } from './imageCallbacks'
import { createTextCallbacks } from './textCallbacks'
import { createThinkingCallbacks } from './thinkingCallbacks'
import { createToolCallbacks } from './toolCallbacks'
import { createVideoCallbacks } from './videoCallbacks'

interface CallbacksDependencies {
  blockManager: BlockManager
  dispatch: any
  getState: any
  topicId: string
  assistantMsgId: string
  saveUpdatesToDB: any
  assistant: Assistant
}

export const createCallbacks = (deps: CallbacksDependencies) => {
  const { blockManager, dispatch, getState, topicId, assistantMsgId, saveUpdatesToDB, assistant } = deps

  // 首先创建 thinkingCallbacks ，以便传递 getCurrentThinkingInfo 给 baseCallbacks
  const thinkingCallbacks = createThinkingCallbacks({
    blockManager,
    assistantMsgId
  })

  // 创建基础回调
  const baseCallbacks = createBaseCallbacks({
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB,
    assistant,
    getCurrentThinkingInfo: thinkingCallbacks.getCurrentThinkingInfo
  })

  const toolCallbacks = createToolCallbacks({
    blockManager,
    assistantMsgId,
    dispatch
  })

  const imageCallbacks = createImageCallbacks({
    blockManager,
    assistantMsgId
  })

  const videoCallbacks = createVideoCallbacks({ blockManager, assistantMsgId })

  const compactCallbacks = createCompactCallbacks({
    blockManager,
    assistantMsgId,
    dispatch,
    getState,
    topicId,
    saveUpdatesToDB
  })

  // 创建textCallbacks时传入compactCallbacks的handleTextComplete方法
  const textCallbacks = createTextCallbacks({
    blockManager,
    assistantMsgId,
    handleCompactTextComplete: compactCallbacks.handleTextComplete
  })

  // 组合所有回调
  return {
    ...baseCallbacks,
    ...textCallbacks,
    ...thinkingCallbacks,
    ...toolCallbacks,
    ...imageCallbacks,
    ...videoCallbacks,
    ...compactCallbacks,
    // 清理资源的方法
    cleanup: () => {
      // 清理由 messageThunk 中的节流函数管理，这里不需要特别处理
      // 如果需要，可以调用 blockManager 的相关清理方法
    }
  }
}
