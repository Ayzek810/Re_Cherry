/**
 * `resolvedInputs`（审批放行后的改写入参）必须有界，且能按话题清理。
 *
 * 背景：只有直播路径的 `tool/result`（`removeByToolCallId`）会删条目；历史投影路径
 * （kernelChat 回放）不调用它，回合被中断/结果从未到达时条目也会留存。因此：
 * - `clearByTopic` 必须清掉该话题**已放行**的入参（归属按 `requestReceived.topicId` 记录）；
 * - 未决审批一起作废（原有语义）；
 * - 兜底 FIFO 上限使这张表不会随审批次数无限增长。
 */
import { describe, expect, it } from 'vitest'

import type { ToolPermissionRequestPayload } from '../toolPermissions'
import reducer, { toolPermissionsActions, type ToolPermissionsState } from '../toolPermissions'

function request(requestId: string, toolCallId: string, topicId?: string): ToolPermissionRequestPayload {
  return {
    requestId,
    toolName: 'read_file',
    toolId: 'tool-1',
    toolCallId,
    topicId,
    requiresPermissions: true,
    input: { path: `/tmp/${toolCallId}` },
    inputPreview: '{}',
    createdAt: 1,
    suggestions: []
  }
}

function allow(
  state: ToolPermissionsState,
  requestId: string,
  toolCallId: string,
  updatedInput: Record<string, unknown>
): ToolPermissionsState {
  return reducer(
    state,
    toolPermissionsActions.requestResolved({
      requestId,
      behavior: 'allow',
      updatedInput,
      toolCallId,
      reason: 'response'
    })
  )
}

describe('toolPermissions.resolvedInputs', () => {
  it('clearByTopic 清掉该话题已放行的入参（历史投影路径不调用 removeByToolCallId）', () => {
    let state = reducer(undefined, toolPermissionsActions.requestReceived(request('r1', 'call-1', 'topic-a')))
    state = reducer(state, toolPermissionsActions.requestReceived(request('r2', 'call-2', 'topic-b')))
    state = allow(state, 'r1', 'call-1', { path: '/a' })
    state = allow(state, 'r2', 'call-2', { path: '/b' })

    expect(state.resolvedInputs['call-1']).toEqual({ path: '/a' })
    expect(state.resolvedInputs['call-2']).toEqual({ path: '/b' })

    state = reducer(state, toolPermissionsActions.clearByTopic({ topicId: 'topic-a' }))

    // topic-a 的已放行入参被清；topic-b 不受影响
    expect(state.resolvedInputs['call-1']).toBeUndefined()
    expect(state.resolvedInputs['call-2']).toEqual({ path: '/b' })
    expect(state.resolvedInputTopics['call-1']).toBeUndefined()
    expect(state.resolvedInputTopics['call-2']).toBe('topic-b')
    expect(state.resolvedInputOrder).toEqual(['call-2'])
  })

  it('clearByTopic 同时作废该话题未决审批与其已放行入参', () => {
    let state = reducer(undefined, toolPermissionsActions.requestReceived(request('r1', 'call-1', 'topic-a')))
    state = reducer(state, toolPermissionsActions.requestReceived(request('r2', 'call-2', 'topic-a')))
    state = allow(state, 'r1', 'call-1', { path: '/a' })
    // r2 仍未决
    expect(state.requests['r2']).toBeDefined()

    state = reducer(state, toolPermissionsActions.clearByTopic({ topicId: 'topic-a' }))

    expect(state.requests['r2']).toBeUndefined()
    expect(state.resolvedInputs['call-1']).toBeUndefined()
  })

  it('removeByToolCallId 仍按单条清理（直播 tool/result 路径）', () => {
    let state = reducer(undefined, toolPermissionsActions.requestReceived(request('r1', 'call-1', 'topic-a')))
    state = allow(state, 'r1', 'call-1', { path: '/a' })
    state = reducer(state, toolPermissionsActions.removeByToolCallId({ toolCallId: 'call-1' }))
    expect(state.resolvedInputs['call-1']).toBeUndefined()
    expect(state.resolvedInputOrder).toEqual([])
  })

  it('resolvedInputs 有 FIFO 上限：连续放行不会使这张表无限增长', () => {
    let state: ToolPermissionsState = reducer(undefined, { type: '@@init' })
    const total = 260
    for (let i = 0; i < total; i += 1) {
      const requestId = `r-${i}`
      const toolCallId = `call-${i}`
      state = reducer(state, toolPermissionsActions.requestReceived(request(requestId, toolCallId, 'topic-a')))
      state = allow(state, requestId, toolCallId, { path: `/tmp/${i}` })
    }
    const size = Object.keys(state.resolvedInputs).length
    expect(size).toBeLessThanOrEqual(200)
    // 最旧的条目被淘汰，最新的仍可读
    expect(state.resolvedInputs[`call-${total - 1}`]).toEqual({ path: `/tmp/${total - 1}` })
    expect(state.resolvedInputs['call-0']).toBeUndefined()
    expect(state.resolvedInputOrder.length).toBe(size)
  })
})
