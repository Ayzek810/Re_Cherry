/**
 * 暂停的单一路径契约（2026-10-01 重做后）。
 *
 * 旧实现靠「用户消息 id → 回调」登记表 + 消息 id 改写时迁移键 + 键失配时兜底再发一次停止，
 * 三件套互相牵制（两套账、索引漏项、残留闭包）。重做后按**话题**记账：
 *
 *   `pauseMessages` = ① 本地当帧落态（`kernelChat.cancelActiveTurn`：标记回合已取消 +
 *   流式块/消息落 PAUSED，界面立刻停）② 发一次内核停止（fire-and-forget，主进程同一 IPC
 *   还会中止我们自己的在途长活）③ 落 loading=false。
 *
 * 界面状态**不再依赖内核**：内核停止失败只记日志 + 提示，本地已是"已停"。
 */
import type { newMessagesActions as RealNewMessagesActions } from '@renderer/store/newMessage'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const topicId = 'topic-1'
const toastError = vi.fn()
const dshTopicStop = vi.fn()
const cancelActiveTurn = vi.fn()
const dispatchSpy = vi.fn()

vi.mock('@renderer/store', () => {
  const store = {
    getState: () => ({ messages: {}, runtime: {}, assistants: { assistants: [] } }),
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
  cancelActiveTurn: (id: string) => cancelActiveTurn(id),
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

import { useMessageOperations } from '../useMessageOperations'

const topic = { id: topicId, name: 't', assistantId: 'a' } as never

beforeEach(() => {
  toastError.mockReset()
  dshTopicStop.mockReset()
  cancelActiveTurn.mockReset()
  dispatchSpy.mockReset()
  cancelActiveTurn.mockReturnValue(true)
  dshTopicStop.mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown; toast: unknown }).api = { dshTopicStop }
  ;(window as unknown as { toast: unknown }).toast = { error: toastError, success: vi.fn(), info: vi.fn() }
})

describe('useMessageOperations.pauseMessages（单一路径）', () => {
  it('总是先本地当帧落态，再发一次内核停止，并落 loading=false', async () => {
    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    expect(cancelActiveTurn).toHaveBeenCalledWith(topicId)
    // 一条路：无条件发一次内核停止（不再有"命中登记才发 / 不命中才兜底"的分支）
    expect(dshTopicStop).toHaveBeenCalledTimes(1)
    expect(dshTopicStop).toHaveBeenCalledWith(topicId)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'test/setTopicLoading', payload: { topicId, loading: false } })
    )
  })

  it('没有活跃回合时也照发内核停止（覆盖内核侧残留的收尾），不谎报也不静默', async () => {
    cancelActiveTurn.mockReturnValue(false)

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    expect(dshTopicStop).toHaveBeenCalledWith(topicId)
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ payload: { topicId, loading: false } }))
  })

  it('内核停止失败：本地仍是"已停"（界面不依赖内核），但必须提示且记日志', async () => {
    dshTopicStop.mockRejectedValue(new Error('kernel down'))

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.pauseMessages()

    // 关键语义：失败不改界面状态（用户按了停 → 界面就是停），但要有可见信号
    expect(toastError).toHaveBeenCalledWith('chat.pause.failed')
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ payload: { topicId, loading: false } }))
  })
})
