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

// 本文件要拉起 `useAssistant` 的真实模块图（含模型/助手配置），满负载下首个用例可达 16~30s：
// 默认 20s 会在全量并行跑时误红。放宽超时是**避免用时间做信号**，不是把慢当绿。
vi.setConfig({ testTimeout: 60000 })

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
// `reasoningOptionsForModel` 会拉起整张 provider/model 配置图（实测满负载下首例 20~30s）：
// 本用例只关心删除路径，故整体桩掉。
vi.mock('@renderer/utils/reasoningKernel', () => ({
  reasoningOptionsForModel: () => [],
  kernelReasoningLevelFor: () => undefined,
  kernelReasoningEffortsForModel: () => []
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

/**
 * 只看**删除路径**的 dispatch。`useAssistant` 自身的 effect 也可能 dispatch（例如思考档位
 * `updateAssistantSettings`），断言里把它们算进来会在满负载下变成 flaky（本轮实测踩到）。
 */
const deletePathTypes = (): string[] =>
  dispatchedTypes().filter((type) => type === 'assistants/removeTopic' || type === 'assistants/addTopic')

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

    expect(deletePathTypes()).toEqual(['assistants/removeTopic'])
    await vi.waitFor(() => expect(kernelDelete).toHaveBeenCalledWith('topic-a'))
    expect(deletePathTypes()).toEqual(['assistants/removeTopic']) // 内核确认后不得再有回滚
    expect(toastError).not.toHaveBeenCalled()
  })

  it('内核删除失败 → **把行放回去**并提示（不留下"渲染层已删、内核还在"的分歧）', async () => {
    kernelDelete.mockResolvedValue(false)
    const { useAssistant } = await loadHook()
    const { result } = renderHook(() => useAssistant('assistant-1'))

    result.current.removeTopic(topic('topic-a'))

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('chat.topics.manage.delete.error'), {
      timeout: 10000
    })
    expect(deletePathTypes()).toEqual(['assistants/removeTopic', 'assistants/addTopic'])
    const rollback = dispatch.mock.calls.find(
      ([action]) => (action as { type: string }).type === 'assistants/addTopic'
    ) as [{ payload: { topic: Topic } }]
    expect(rollback[0].payload.topic.id).toBe('topic-a')
  })
})
