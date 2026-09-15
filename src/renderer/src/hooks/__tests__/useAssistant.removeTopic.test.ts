import type * as ModelsModule from '@renderer/config/models'
import { type Topic, TopicType } from '@renderer/types'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UseAssistantModule from '../useAssistant'

/**
 * `useAssistant().removeTopic` 的**乐观删除 + 失败回滚**（v0.3.0-2 §6.9）。
 *
 * 真机实证的产线：旧写法 `void TopicManager.removeTopic(id)` 把内核侧失败吞成一条日志，渲染层行照删、
 * 内核行还在 → 沉淀出"删过又看得见"的幽灵话题（2026-09-15 那次运行里 9 个）。修法是把删除结果
 * 变成真信号：内核没删掉就把行放回去并提示。
 */
const dispatch = vi.fn()
const kernelDelete = vi.fn()
const toastError = vi.fn()
let topics: Topic[] = []

vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      assistants: { assistants: [{ id: 'assistant-1', topics, model: { id: 'model-1', provider: 'p1' } }] },
      llm: { defaultModel: { id: 'model-1', provider: 'p1' }, quickModel: undefined }
    }),
  useAppDispatch: () => dispatch
}))

vi.mock('../useTopic', () => ({
  TopicManager: {
    removeTopic: (id: string) => kernelDelete(id) as Promise<boolean>,
    clearTopicMessages: vi.fn()
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
// AssistantService 只为默认值/默认话题服务（它会拉起 i18n 与配置图，与本用例无关）。
vi.mock('@renderer/services/AssistantService', () => ({
  DEFAULT_ASSISTANT_SETTINGS: {},
  getDefaultAssistant: () => ({ id: 'assistant-1', name: 'A', topics: [], model: { id: 'model-1', provider: 'p1' } }),
  getDefaultTopic: (assistantId: string) => ({
    id: 'default-topic',
    assistantId,
    name: '默认话题',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: []
  })
}))
// 只覆盖与用例无关的两个判定（保留原模块其余导出，避免"mock 少了导出"的连锁报错）
vi.mock('@renderer/config/models', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelsModule>()),
  isSupportedReasoningEffortModel: () => false,
  isSupportedThinkingTokenModel: () => false
}))

function topic(id: string): Topic {
  return {
    id,
    type: TopicType.Chat,
    assistantId: 'assistant-1',
    name: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: []
  }
}

async function loadHook(): Promise<typeof UseAssistantModule> {
  return await import('../useAssistant')
}

const dispatchedTypes = (): string[] => dispatch.mock.calls.map(([action]) => (action as { type: string }).type)

beforeEach(() => {
  dispatch.mockClear()
  kernelDelete.mockReset()
  toastError.mockClear()
  topics = [topic('topic-a'), topic('topic-b')]
  ;(window as unknown as { toast: unknown }).toast = { error: toastError, success: vi.fn(), warning: vi.fn() }
})

describe('useAssistant().removeTopic（乐观删除 + 失败回滚）', () => {
  it('内核删除成功 → 行先消失，确认后不再有任何后续动作、不提示', async () => {
    kernelDelete.mockResolvedValue(true)
    const { useAssistant } = await loadHook()
    const { result } = renderHook(() => useAssistant('assistant-1'))

    result.current.removeTopic(topic('topic-a'))

    expect(dispatchedTypes()).toEqual(['assistants/removeTopic'])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(dispatchedTypes()).toEqual(['assistants/removeTopic'])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('内核删除失败 → **把行放回去**并提示（不留下"渲染层已删、内核还在"的分歧）', async () => {
    kernelDelete.mockResolvedValue(false)
    const { useAssistant } = await loadHook()
    const { result } = renderHook(() => useAssistant('assistant-1'))

    result.current.removeTopic(topic('topic-a'))

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('chat.topics.manage.delete.error'))
    expect(dispatchedTypes()).toEqual(['assistants/removeTopic', 'assistants/addTopic'])
    const rollback = dispatch.mock.calls[1][0] as { payload: { topic: Topic } }
    expect(rollback.payload.topic.id).toBe('topic-a')
  })
})
