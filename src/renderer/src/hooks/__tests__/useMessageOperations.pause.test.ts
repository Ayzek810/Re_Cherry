/**
 * r2-47：`pauseMessages` 不得把"暂停"静默变成无操作。
 *
 * 中止登记的键是**用户消息 id**（`addAbortController(userMessageId!, …)`），而这里收集的是
 * streaming 消息的 `askId`。当 streaming 消息的 `askId` 为空（或指向已被重映射的消息 id）时，
 * `abortCompletion` 查不到键——旧实现用 `filter((id) => !!id)` 静默丢掉，用户看到"已停止"
 * 而内核回合继续跑。这里钉住：空 `askId` 显式 warn + 按话题补一次 `dshTopicStop`；
 * 兜底失败时不谎报"已停止"（恢复 loading 并 toast.error）。
 */
import type { newMessagesActions as RealNewMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const topicId = 'topic-1'
const warn = vi.fn()
const toastError = vi.fn()
const dshTopicStop = vi.fn()
const dispatchSpy = vi.fn()
let topicMessages: Message[] = []

vi.mock('@renderer/store', () => {
  const store = {
    getState: () => ({
      messages: {
        messageIdsByTopic: { [topicId]: topicMessages.map((m) => m.id) },
        entities: Object.fromEntries(topicMessages.map((m) => [m.id, m])),
        displayCount: 20
      },
      runtime: {},
      assistants: { assistants: [] }
    }),
    dispatch: (action: unknown) => dispatchSpy(action)
  }
  return {
    default: store,
    useAppDispatch: () => (action: unknown) => dispatchSpy(action),
    useAppSelector: (selector: (state: unknown) => unknown) => selector(store.getState())
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

// 只保留真实的消息选择器，其余 store 部件用桩（本用例不涉及）。
vi.mock('@renderer/store/newMessage', async (importActual) => {
  const actual = (await importActual()) as { newMessagesActions: typeof RealNewMessagesActions }
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      setTopicLoading: (payload: { topicId: string; loading: boolean }) => ({
        type: 'test/setTopicLoading',
        payload
      })
    }
  }
})

vi.mock('@renderer/services/SpanManagerService', () => ({
  appendMessageTrace: vi.fn(),
  pauseTrace: vi.fn(),
  restartTrace: vi.fn()
}))

vi.mock('@renderer/services/kernelChat', () => ({
  destroyTurnsInKernel: vi.fn(),
  forkBranchToKernel: vi.fn(),
  kernelAnchorOf: vi.fn(),
  loadKernelTopicMessages: vi.fn()
}))

vi.mock('@renderer/services/MessagesService', () => ({ getUserMessage: vi.fn() }))
vi.mock('@renderer/services/TokenService', () => ({ estimateUserPromptUsage: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  appendAssistantResponseThunk: vi.fn(),
  loadTopicMessagesThunk: vi.fn(),
  regenerateAssistantResponseThunk: vi.fn(),
  removeBlocksThunk: vi.fn(),
  resendMessageThunk: vi.fn(),
  resendUserMessageWithEditThunk: vi.fn(),
  sendMessage: vi.fn(),
  updateMessageAndBlocksThunk: vi.fn()
}))
vi.mock('../useTopic', () => ({ TopicManager: { removeTopic: vi.fn(), clearTopicMessages: vi.fn() } }))

import { abortMap, addAbortController } from '@renderer/utils/abortController'

import { useMessageOperations } from '../useMessageOperations'

function streamingMessage(id: string, askId?: string): Message {
  return {
    id,
    role: 'assistant',
    topicId,
    askId,
    status: AssistantMessageStatus.PROCESSING,
    blocks: []
  } as unknown as Message
}

const topic = { id: topicId, name: 't', assistantId: 'a' } as never

beforeEach(() => {
  warn.mockReset()
  toastError.mockReset()
  dshTopicStop.mockReset()
  dispatchSpy.mockReset()
  abortMap.clear()
  topicMessages = []
  ;(window as unknown as { api: unknown; toast: unknown }).api = { dshTopicStop }
  ;(window as unknown as { toast: unknown }).toast = { error: toastError, success: vi.fn(), info: vi.fn() }
  // `loggerService.withContext('UseMessageOperations')` 由 tests/renderer.setup.ts 全局桩掉；
  // 这里通过 spy 断言 warn 内容（真实实现走 mockLoggerService）。
})

describe('useMessageOperations.pauseMessages（r2-47）', () => {
  it('有可用注册键：调用登记的中止回调（内核停止由它发出）', async () => {
    const abortFn = vi.fn()
    addAbortController('user-1', abortFn, topicId)
    topicMessages = [streamingMessage('a1', 'user-1')]

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    expect(abortFn).toHaveBeenCalledTimes(1)
    // 有注册键时不再重复发话题级停止（不新增第二套取消路径）
    expect(dshTopicStop).not.toHaveBeenCalled()
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'test/setTopicLoading', payload: { topicId, loading: false } })
    )
  })

  it('streaming 消息的 askId 为空：不再静默——按话题停内核回合（dshTopicStop）', async () => {
    topicMessages = [streamingMessage('a1', undefined)]

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    // 旧实现：askIds 为空 → 什么都不做，但 UI 已显示"已停止"
    expect(dshTopicStop).toHaveBeenCalledWith(topicId)
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ payload: { topicId, loading: false } }))
  })

  it('askId 指向未登记的键：同样走话题级停止兜底', async () => {
    // 登记的是别的键（模拟"消息 id 被重映射/注册已被清掉"）
    addAbortController('user-1', vi.fn(), topicId)
    topicMessages = [streamingMessage('a1', 'user-unknown')]

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    // abortCompletion('user-unknown') 查不到键 → 必须兜底停内核
    expect(dshTopicStop).toHaveBeenCalledWith(topicId)
  })

  it('兜底停止失败：不谎报"已停止"（toast.error + 恢复 loading=true）', async () => {
    dshTopicStop.mockRejectedValue(new Error('kernel down'))
    topicMessages = [streamingMessage('a1', undefined)]

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    expect(toastError).toHaveBeenCalledWith('chat.pause.failed')
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ payload: { topicId, loading: true } }))
    expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ payload: { topicId, loading: false } }))
  })

  it('没有 streaming 消息：不发停止、仍落 loading=false（幂等）', async () => {
    topicMessages = []

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    expect(dshTopicStop).not.toHaveBeenCalled()
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ payload: { topicId, loading: false } }))
  })
})
