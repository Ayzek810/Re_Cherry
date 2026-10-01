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
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'

export type ToolPermissionRequestPayload = {
  requestId: string
  toolName: string
  toolId: string
  toolCallId: string
  /** 发起审批的话题（内核审批往返按话题区分归属）。 */
  topicId?: string
  description?: string
  requiresPermissions: boolean
  input: Record<string, unknown>
  inputPreview: string
  createdAt: number
  suggestions: PermissionUpdate[]
  autoApprove?: boolean
}

export type ToolPermissionResultPayload = {
  requestId: string
  behavior: 'allow' | 'deny'
  message?: string
  reason: 'response' | 'timeout' | 'aborted' | 'no-window'
  toolCallId?: string
  updatedInput?: Record<string, unknown>
}

export type ToolPermissionStatus = 'pending' | 'submitting-allow' | 'submitting-deny' | 'invoking'

export type ToolPermissionEntry = ToolPermissionRequestPayload & {
  status: ToolPermissionStatus
  resolvedInput?: Record<string, unknown>
}

/**
 * `resolvedInputs` 的条目上限：审批放行写入的"已改写入参"只有**该工具结果**
 * 才需要（`toolCallbacks.onToolCallComplete` 读一次即删）。直播 `tool/result` 与
 * `removeByToolCallId` 都会删；回合被中断、或结果从未到达时条目会留存，故加一层
 * 按录入顺序的 FIFO 上限，使这张表（含完整工具入参）不会随审批次数无限增长。
 */
const RESOLVED_INPUTS_MAX = 200

export interface ToolPermissionsState {
  requests: Record<string, ToolPermissionEntry>
  /** `toolCallId` → 审批放行后的改写入参。读取点：`toolCallbacks.onToolCallComplete`。 */
  resolvedInputs: Record<string, Record<string, unknown>>
  /** `resolvedInputs` 的录入顺序（FIFO 淘汰用；不参与渲染）。 */
  resolvedInputOrder: string[]
  /** `toolCallId` → 归属话题，使 `clearByTopic` 能清掉该话题的已放行入参。 */
  resolvedInputTopics: Record<string, string>
}

const initialState: ToolPermissionsState = {
  requests: {},
  resolvedInputs: {},
  resolvedInputOrder: [],
  resolvedInputTopics: {}
}

/** 写入一条已放行入参并按 FIFO 上限淘汰最旧条目。 */
function setResolvedInput(
  state: ToolPermissionsState,
  toolCallId: string,
  input: Record<string, unknown>,
  topicId: string | undefined
): void {
  if (!(toolCallId in state.resolvedInputs)) {
    state.resolvedInputOrder.push(toolCallId)
  }
  state.resolvedInputs[toolCallId] = input
  if (topicId === undefined) {
    delete state.resolvedInputTopics[toolCallId]
  } else {
    state.resolvedInputTopics[toolCallId] = topicId
  }
  while (state.resolvedInputOrder.length > RESOLVED_INPUTS_MAX) {
    const oldest = state.resolvedInputOrder.shift()
    if (oldest === undefined) break
    delete state.resolvedInputs[oldest]
    delete state.resolvedInputTopics[oldest]
  }
}

/** 删除一条已放行入参及其归属索引。 */
function deleteResolvedInput(state: ToolPermissionsState, toolCallId: string): void {
  if (toolCallId in state.resolvedInputs) {
    delete state.resolvedInputs[toolCallId]
  }
  delete state.resolvedInputTopics[toolCallId]
  const index = state.resolvedInputOrder.indexOf(toolCallId)
  if (index !== -1) {
    state.resolvedInputOrder.splice(index, 1)
  }
}

const toolPermissionsSlice = createSlice({
  name: 'toolPermissions',
  initialState,
  reducers: {
    requestReceived: (state, action: PayloadAction<ToolPermissionRequestPayload>) => {
      const payload = action.payload
      state.requests[payload.requestId] = {
        ...payload,
        status: 'pending'
      }
    },
    submissionSent: (state, action: PayloadAction<{ requestId: string; behavior: 'allow' | 'deny' }>) => {
      const { requestId, behavior } = action.payload
      const entry = state.requests[requestId]
      if (!entry) return

      entry.status = behavior === 'allow' ? 'submitting-allow' : 'submitting-deny'
    },
    submissionFailed: (state, action: PayloadAction<{ requestId: string }>) => {
      const entry = state.requests[action.payload.requestId]
      if (!entry) return
      entry.status = 'pending'
    },
    requestResolved: (state, action: PayloadAction<ToolPermissionResultPayload>) => {
      const { requestId, behavior, updatedInput } = action.payload
      const entry = state.requests[requestId]

      if (!entry) return

      if (behavior === 'allow') {
        entry.status = 'invoking'
        entry.resolvedInput = updatedInput
        if (updatedInput && entry.toolCallId) {
          setResolvedInput(state, entry.toolCallId, updatedInput, entry.topicId)
        }
      } else {
        delete state.requests[requestId]
      }
    },
    removeByToolCallId: (state, action: PayloadAction<{ toolCallId: string }>) => {
      const { toolCallId } = action.payload

      const entryId = Object.keys(state.requests).find((key) => state.requests[key]?.toolCallId === toolCallId)
      if (entryId) {
        delete state.requests[entryId]
      }
      deleteResolvedInput(state, toolCallId)
    },
    /**
     * 回合结束/话题删除时作废该话题的未决审批（abort 路径的兜底清理）。
     *
     * 同时清掉该话题**已放行**的入参投影。历史投影路径（kernelChat 回放）不调用
     * `removeByToolCallId`，因此只重开一次历史话题就会留下永久条目；这些条目的归属只能在
     * 写入时按 `requestReceived.topicId` 记录（`resolvedInputTopics`），所以这里按同一话题清。
     * `topicId` 缺失的未决审批无法归属到话题（`entry.topicId === undefined`），维持原有语义不动。
     */
    clearByTopic: (state, action: PayloadAction<{ topicId: string }>) => {
      const { topicId } = action.payload
      for (const [key, entry] of Object.entries(state.requests)) {
        if (entry.topicId === topicId) {
          delete state.requests[key]
          if (entry.toolCallId !== undefined) {
            deleteResolvedInput(state, entry.toolCallId)
          }
        }
      }
      for (const [toolCallId, owner] of Object.entries(state.resolvedInputTopics)) {
        if (owner === topicId) {
          deleteResolvedInput(state, toolCallId)
        }
      }
    },
    clearAll: (state) => {
      state.requests = {}
      state.resolvedInputs = {}
      state.resolvedInputOrder = []
      state.resolvedInputTopics = {}
    },
    clearPending: (state) => {
      for (const [key, entry] of Object.entries(state.requests)) {
        if (entry.status === 'pending' || entry.status === 'submitting-allow' || entry.status === 'submitting-deny') {
          delete state.requests[key]
        }
      }
    }
  }
})

export const toolPermissionsActions = toolPermissionsSlice.actions

export default toolPermissionsSlice.reducer
