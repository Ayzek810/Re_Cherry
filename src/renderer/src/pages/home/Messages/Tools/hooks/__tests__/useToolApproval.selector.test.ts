import type { RootState } from '@renderer/store'
import { describe, expect, it, vi } from 'vitest'

import { selectApprovalRequestByToolCallId } from '../useToolApproval'

const request = (requestId: string, toolCallId: string, status: 'pending' | 'invoking') => ({
  requestId,
  toolName: 'read',
  toolId: toolCallId,
  toolCallId,
  requiresPermissions: true,
  input: {},
  inputPreview: '',
  createdAt: 1,
  suggestions: [],
  status
})

const stateWith = (requests: Record<string, unknown>) =>
  ({ toolPermissions: { requests, resolvedInputs: {} } }) as unknown as RootState

describe('selectApprovalRequestByToolCallId', () => {
  it('indexes pending approvals by toolCallId (toolId === callId in the projection)', () => {
    const state = stateWith({
      'req-1': request('req-1', 'call-1', 'pending'),
      'req-2': request('req-2', 'call-2', 'invoking')
    })

    const index = selectApprovalRequestByToolCallId(state)

    expect(index.get('call-1')?.requestId).toBe('req-1')
    expect(index.get('call-2')?.requestId).toBe('req-2')
    expect(index.get('call-3')).toBeUndefined()
  })

  it('builds the index once per requests slice identity, not once per block lookup', () => {
    const state = stateWith({
      'req-1': request('req-1', 'call-1', 'pending'),
      'req-2': request('req-2', 'call-2', 'pending')
    })

    const valuesSpy = vi.spyOn(Object, 'values')
    const first = selectApprovalRequestByToolCallId(state)
    valuesSpy.mockClear()

    // 15 个工具块读同一份 store 状态 = 15 次 O(1) 取索引，0 次全表扫描（旧实现是 15 次 Object.values + find）
    for (let i = 0; i < 15; i++) {
      expect(selectApprovalRequestByToolCallId(state).get('call-2')?.requestId).toBe('req-2')
    }
    expect(valuesSpy).not.toHaveBeenCalled()
    expect(selectApprovalRequestByToolCallId(state)).toBe(first)
    valuesSpy.mockRestore()
  })

  it('rebuilds the index when the requests slice changes', () => {
    const first = selectApprovalRequestByToolCallId(stateWith({ 'req-1': request('req-1', 'call-1', 'pending') }))
    const second = selectApprovalRequestByToolCallId(
      stateWith({ 'req-1': request('req-1', 'call-1', 'pending'), 'req-2': request('req-2', 'call-2', 'pending') })
    )

    expect(second).not.toBe(first)
    expect(second.get('call-2')?.requestId).toBe('req-2')
  })
})
