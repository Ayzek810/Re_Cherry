/**
 * r2-66 行为回归：在途流的查找与取消只有一份实现。
 *
 * 缺陷：`clearConversation` 用「状态 = PROCESSING」找在途助手消息，`handlePause` 用
 * 「askId/id 命中本轮提问」找。两套判据各自演化。只改一处，另一条路径就漏掉真取消，旧流继续计费。
 * 收敛后两条路径都走 `abortInFlight`，判据是两者的并集。`markPaused` 决定是否落 PAUSED 终态。
 *
 * 本文件用真 store + 真 reducer 证明两件事：
 *   ① 两条路径都真取消在途流（`lightStreamAbort` 收到在途助手消息 id）；
 *   ② `handlePause` 额外把消息与流式块落 PAUSED，`clearConversation` 不落。
 *
 * `clearConversation` 只在「路由回到 home」时调用。回到 home 之前会用新 uuid 建话题，测试无法
 * 预先得知该 id。故此处固定 `getDefaultTopic` 的话题 id，并在挂载前把在途消息放进该话题。
 * 挂载 effect 就是真实的 `clearConversation` 调用点。
 */
import '@renderer/i18n'

import type * as AssistantServiceModule from '@renderer/services/AssistantService'
import { lightStream, lightStreamAbort } from '@renderer/services/lightLlm'
import store from '@renderer/store'
import { setQuickAssistantModel } from '@renderer/store/llm'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus } from '@renderer/types/newMessage'
import { createMainTextBlock } from '@renderer/utils/messageUtils/create'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import HomeWindow from '../HomeWindow'

/** 固定的话题 id：测试必须在组件挂载前，把在途消息放进该话题。 */
const TEST_TOPIC_ID = 'mini-topic-in-flight-test'
const IN_FLIGHT_MESSAGE_ID = 'assistant-in-flight'
const MINI_ASSISTANT_ID = 'quick-assistant'

vi.mock('@renderer/services/AssistantService', async (importOriginal) => {
  const actual = await importOriginal<typeof AssistantServiceModule>()
  return {
    ...actual,
    getDefaultTopic: (assistantId: string) => ({ ...actual.getDefaultTopic(assistantId), id: TEST_TOPIC_ID })
  }
})

vi.mock('@renderer/services/lightLlm', () => ({
  lightStream: vi.fn(),
  lightStreamAbort: vi.fn().mockResolvedValue(undefined)
}))

/** 探针：ChatWindow 原本渲染整棵 Messages 树；r2-02 只关心驱动加载动画的 `isOutputted`。 */
vi.mock('../../chat/ChatWindow', () => ({
  default: ({ isOutputted }: { isOutputted: boolean }) => (
    <div data-testid="chat-window" data-outputted={String(isOutputted)} />
  )
}))

const MODEL = {
  id: 'quick-model',
  provider: 'test-provider',
  name: 'Quick Model',
  group: 'test'
}

const sendWithEnter = async (text: string) => {
  await act(async () => {
    const input = document.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: text } })
  })
  await act(async () => {
    const input = document.querySelector('input') as HTMLInputElement
    fireEvent.keyDown(input, { code: 'Enter', key: 'Enter' })
  })
}

const lastAssistantMessage = (): Message | undefined => {
  const entities = Object.values(store.getState().messages.entities) as (Message | undefined)[]
  return entities.filter((m): m is Message => m?.role === 'assistant').at(-1)
}

const renderWindow = () =>
  render(
    <Provider store={store}>
      <HomeWindow />
    </Provider>
  )

beforeAll(() => {
  // antd Col 的响应式观察器依赖 matchMedia（jsdom 未内置）
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

describe('HomeWindow · r2-66 在途流取消收敛', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.dispatch(setQuickAssistantModel({ model: undefined }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api?: Record<string, unknown> }).api,
      miniWindow: { setPin: vi.fn().mockResolvedValue(undefined), hide: vi.fn() },
      events: { onShowMiniWindow: vi.fn(() => () => {}) }
    }
    ;(window as unknown as { toast: Record<string, unknown> }).toast = {
      info: vi.fn(),
      error: vi.fn(),
      success: vi.fn()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clearConversation（路由回 home）真取消在途流，且不落 PAUSED', async () => {
    const block = createMainTextBlock(IN_FLIGHT_MESSAGE_ID, 'partial', { status: MessageBlockStatus.STREAMING })
    const inFlight: Message = {
      id: IN_FLIGHT_MESSAGE_ID,
      role: 'assistant',
      assistantId: MINI_ASSISTANT_ID,
      topicId: TEST_TOPIC_ID,
      createdAt: new Date().toISOString(),
      status: AssistantMessageStatus.PROCESSING,
      askId: 'ask-in-flight',
      blocks: [block.id]
    }
    store.dispatch(upsertManyBlocks([block]))
    store.dispatch(newMessagesActions.addMessage({ topicId: TEST_TOPIC_ID, message: inFlight }))

    const dispatchSpy = vi.spyOn(store, 'dispatch')

    // 挂载时 route === 'home'，effect 调用 clearConversation——这就是清空会话的真实入口。
    renderWindow()

    // (a) 真取消：在途助手消息 id 就是该流的 requestId。
    await waitFor(() => expect(lightStreamAbort).toHaveBeenCalledWith(IN_FLIGHT_MESSAGE_ID))

    // (b) 不落 PAUSED：没有任何把消息或块置 PAUSED 的派发。
    const pausedDispatches = dispatchSpy.mock.calls.filter(([action]) => {
      const payload = (action as { payload?: { updates?: { status?: string }; changes?: { status?: string } } }).payload
      return (
        payload?.updates?.status === AssistantMessageStatus.PAUSED ||
        payload?.changes?.status === MessageBlockStatus.PAUSED
      )
    })
    expect(pausedDispatches).toHaveLength(0)
    // 清空会话的第 ② 步整条清掉消息。若不成立，上面的「零 PAUSED」断言就失去意义。
    expect(store.getState().messages.entities[IN_FLIGHT_MESSAGE_ID]).toBeUndefined()
  })

  it('handlePause（ESC）真取消在途流，且把消息与流式块落 PAUSED', async () => {
    store.dispatch(setQuickAssistantModel({ model: MODEL as never }))
    // 通道永不结束：流保持"在途"，只有取消能结束它。
    vi.mocked(lightStream).mockImplementation(() => new Promise<never>(() => {}))

    renderWindow()
    await sendWithEnter('hello')

    await waitFor(() => {
      expect(lastAssistantMessage()?.status).toBe(AssistantMessageStatus.PROCESSING)
      expect(lastAssistantMessage()?.blocks?.length).toBeGreaterThan(0)
    })
    const assistant = lastAssistantMessage() as Message

    await act(async () => {
      const input = document.querySelector('input') as HTMLInputElement
      fireEvent.keyDown(input, { code: 'Escape', key: 'Escape' })
    })

    // (a) 真取消。
    expect(lightStreamAbort).toHaveBeenCalledWith(assistant.id)
    // (b) 暂停额外落 PAUSED 终态：消息与流式块都保留内容、停动画。
    expect(store.getState().messages.entities[assistant.id]?.status).toBe(AssistantMessageStatus.PAUSED)
    expect(store.getState().messageBlocks.entities[assistant.blocks[0]]?.status).toBe(MessageBlockStatus.PAUSED)
    expect(screen.getByTestId('chat-window')).toHaveAttribute('data-outputted', 'true')
  })
})
