import type { Topic } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UseTopicModule from '../useTopic'

/**
 * v0.3.0-2 目标 B（`report.md` §3.3.2-6 / §3.4 的 B-5）：**启动落点的一致性判定**。
 *
 * 这条是"隐藏曾被绕过"的那条通道：初始 `useState` 直接取 `assistant.topics`，没有任何"内核认不认识"
 * 的判定，于是打开一个内核已遗忘的历史话题 → `loadTopicMessagesThunk` → `topic not found` → **空历史**。
 * `report.md` 把它的验证列为真机手测（M1），但那需要一份"渲染层有行、内核已遗忘"的历史数据。
 * 这里把同一场景在 jsdom 里构造出来，使这条验收不再依赖真机数据：判据与回落都在真实 hook 里跑，
 * 只有 IPC 与助手数据是桩。
 */
const dispatch = vi.fn()
const toastWarning = vi.fn()
let assistantTopics: Topic[] = []

vi.mock('../useAssistant', () => ({
  useAssistant: () => ({ assistant: { id: 'assistant-1', topics: assistantTopics } })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({ assistants: { assistants: [{ id: 'assistant-1', topics: assistantTopics }] } }),
    dispatch: (action: unknown) => dispatch(action)
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  loadTopicMessagesThunk: (id: string) => ({ type: 'test/loadTopicMessages', payload: id })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { CHANGE_TOPIC: 'change-topic' },
  EventEmitter: { emit: vi.fn() }
}))

vi.mock('@renderer/services/MessagesService', () => ({ safeDeleteFiles: vi.fn() }))

// 对账服务以桩注入：本文件测"落点判定"，对账本身在 kernelTopics.test.ts 里测。
// hook 是**动态 import** 调它的（静态会与 store/assistants 成环），所以按模块 id 桩。
vi.mock('@renderer/services/kernelTopics', () => ({ reconcileAssistantTopicRows: vi.fn(async () => []) }))

function topic(id: string, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    type: TopicType.Chat,
    assistantId: 'assistant-1',
    name: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...extra
  }
}

function kernelRow(id: string) {
  return { id, name: `kernel-${id}`, createdAt: 1, updatedAt: 2 }
}

function stubApi(list: unknown): void {
  ;(window as unknown as { api: unknown; toast: unknown }).api = {
    dshTopicList: typeof list === 'function' ? list : vi.fn().mockResolvedValue({ topics: list }),
    dshTopicGet: vi.fn().mockResolvedValue({})
  }
}

/** 每次重新取模块：`_activeTopic` 与"上次会话留下的行"登记都是模块内状态。 */
async function loadHook(restoredTopicIds: string[]): Promise<typeof UseTopicModule> {
  vi.resetModules()
  const branch = await import('@renderer/utils/topicBranch')
  branch.noteRestoredTopicIds(restoredTopicIds)
  return await import('../useTopic')
}

beforeEach(() => {
  dispatch.mockClear()
  toastWarning.mockClear()
  assistantTopics = [topic('stale'), topic('live')]
  ;(window as unknown as { toast: unknown }).toast = { warning: toastWarning, success: vi.fn(), error: vi.fn() }
  stubApi([kernelRow('live')])
})

describe('useActiveTopic 的启动落点判定（B-5）', () => {
  it('活跃话题是"上次会话留下、内核已不认识"的行 → 回落到内核确认存在的行，并**显式提示**', async () => {
    const { useActiveTopic } = await loadHook(['stale', 'live'])

    const { result } = renderHook(() => useActiveTopic('assistant-1'))
    expect(result.current.activeTopic?.id).toBe('stale') // 初始落点确实是那一行（复现"隐藏被绕过"）

    await waitFor(() => expect(result.current.activeTopic?.id).toBe('live'))
    expect(toastWarning).toHaveBeenCalledWith('chat.topics.gone')
  })

  it('活跃话题是本进程内新建、尚未建册的行 → **不回落、不提示**（内核不认识它只是因为还没首发）', async () => {
    assistantTopics = [topic('brand-new'), topic('live')]
    const { useActiveTopic } = await loadHook(['live']) // brand-new 不在"上次会话留下的行"里

    const { result } = renderHook(() => useActiveTopic('assistant-1'))

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current.activeTopic?.id).toBe('brand-new')
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('内核未知（IPC 失败）→ 什么都不做（不回落、不提示、不隐藏）', async () => {
    stubApi(() => Promise.reject(new Error('ipc down')))
    const { useActiveTopic } = await loadHook(['stale', 'live'])

    const { result } = renderHook(() => useActiveTopic('assistant-1'))

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current.activeTopic?.id).toBe('stale')
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('活跃话题是 fork 子行 → 不在此判定（`dshTopicList` 只含根，分支落点归分支图）', async () => {
    assistantTopics = [topic('root'), topic('child', { parentTopicId: 'root' })]
    const { useActiveTopic } = await loadHook(['root', 'child'])

    const { result } = renderHook(() => useActiveTopic('assistant-1', topic('child', { parentTopicId: 'root' })))

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current.activeTopic?.id).toBe('child')
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('钩子挂载即触发对账（真机实测：侧栏没展开时对账 effect 不跑，"剪除/补齐"一件都没发生）', async () => {
    const { useActiveTopic } = await loadHook(['stale', 'live'])
    const { reconcileAssistantTopicRows } = await import('@renderer/services/kernelTopics')
    const reconcile = vi.mocked(reconcileAssistantTopicRows)
    reconcile.mockClear()

    renderHook(() => useActiveTopic('assistant-1'))

    await waitFor(() => expect(reconcile).toHaveBeenCalledWith('assistant-1'))
  })

  it('渲染层里没有一行内核确认存在 → 先对账补齐，再从内核的行里落点（"检测到了却无处可落"）', async () => {
    assistantTopics = [topic('stale')] // 只剩幽灵行：没有任何可落点
    const { useActiveTopic } = await loadHook(['stale'])
    const { reconcileAssistantTopicRows } = await import('@renderer/services/kernelTopics')
    const reconcile = vi.mocked(reconcileAssistantTopicRows)
    reconcile.mockClear()
    // 对账的副作用（真实实现会 dispatch addTopic）：把内核确认存在的行补进渲染层
    reconcile.mockImplementation(async () => {
      assistantTopics = [...assistantTopics, topic('live')]
      return []
    })

    const { result } = renderHook(() => useActiveTopic('assistant-1'))

    await waitFor(() => expect(result.current.activeTopic?.id).toBe('live'))
    expect(toastWarning).toHaveBeenCalledWith('chat.topics.gone')
  })
})
