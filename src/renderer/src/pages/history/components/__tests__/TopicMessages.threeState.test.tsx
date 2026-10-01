/**
 * 话题详情把"加载中"、"加载失败"与"确实没有消息"渲染成同一个空态。
 *
 * 三条可观察的差异（旧实现三者同形，本测试全部会红）：
 *   ① 点击话题后的第一帧必须渲染**加载占位**，绝不能先闪一次 `<Empty/>`，
 *      也不能在切到另一条话题时继续渲染上一条话题的消息；
 *   ② 取数失败 → 渲染错误条 + 重试按钮 + `toast.error`，而不是"没有消息"；
 *   ③ 取数成功但消息为空 → 才是真正的空态（`<Empty/>`）。
 */
import '@renderer/i18n'

import SearchPopup from '@renderer/components/Popups/SearchPopup'
import type * as AssistantServiceModule from '@renderer/services/AssistantService'
import { isGenerating } from '@renderer/services/MessagesService'
import NavigationService from '@renderer/services/NavigationService'
import store from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ containerRef: { current: null }, handleScroll: () => {} })
}))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = { messageStyle: '' }
  // 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key] }
})

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// 消息渲染链（Markdown/Shiki/antd 全套）与本次缺陷无关，替身只暴露"渲染了哪条消息"。
vi.mock('../../../home/Messages/Message', () => ({
  default: ({ message }: { message: { id: string } }) => <div data-testid="message-item">{message.id}</div>
}))

// `isGenerating()` 是 `Promise<boolean>` 闸门——`true` = 可以继续，`false` = 正在生成。
// 默认桩返回 `true`（未生成），生成中的用例用 `mockResolvedValueOnce(false)` 覆盖。
vi.mock('@renderer/services/MessagesService', () => ({
  isGenerating: vi.fn().mockResolvedValue(true),
  locateToMessage: vi.fn()
}))

// `MessagesService` 与 `TopicMessages` 都从 `AssistantService` 取东西（含模块初始化期的
// `getDefaultAssistant`），所以按原模块展开后再覆盖单个导出。
vi.mock('@renderer/services/AssistantService', async (importOriginal) => {
  const actual = await importOriginal<typeof AssistantServiceModule>()
  return { ...actual, getAssistantById: vi.fn().mockReturnValue({ id: 'assistant-1' }) }
})

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { SHOW_TOPIC_SIDEBAR: 'SHOW_TOPIC_SIDEBAR' },
  EventEmitter: { emit: vi.fn() }
}))

vi.mock('@renderer/services/NavigationService', () => ({
  default: { navigate: vi.fn() }
}))

vi.mock('@renderer/components/Popups/SearchPopup', () => ({
  default: { hide: vi.fn() }
}))

const getTopicById = vi.fn()
vi.mock('@renderer/hooks/useTopic', () => ({
  getTopicById: (topicId: string) => getTopicById(topicId)
}))

import TopicMessages from '../TopicMessages'

const TOPIC_A = { id: 'topic-a', name: 'A', assistantId: 'assistant-1' } as Topic
const TOPIC_B = { id: 'topic-b', name: 'B', assistantId: 'assistant-1' } as Topic

function message(id: string): Message {
  return {
    id,
    topicId: id.startsWith('a') ? 'topic-a' : 'topic-b',
    role: 'assistant',
    blocks: []
  } as unknown as Message
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const toastError = vi.fn()

function renderPanel(topic: Topic) {
  return render(
    <Provider store={store}>
      <TopicMessages topic={topic} />
    </Provider>
  )
}

describe('TopicMessages 三态渲染', () => {
  beforeEach(() => {
    getTopicById.mockReset()
    toastError.mockReset()
    ;(window as unknown as { toast: unknown }).toast = {
      error: toastError,
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    }
    store.dispatch(newMessagesActions.setCurrentTopicId(null))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('切换话题：取数未完成时渲染加载占位，且不再显示上一条话题的消息', async () => {
    getTopicById.mockResolvedValueOnce({ ...TOPIC_A, messages: [message('a-1')] })
    const { rerender } = renderPanel(TOPIC_A)

    await waitFor(() => expect(screen.getByTestId('message-item')).toHaveTextContent('a-1'))

    // 切到 B：这一条取数故意悬着。
    const pending = deferred<Topic>()
    getTopicById.mockReturnValueOnce(pending.promise)
    rerender(
      <Provider store={store}>
        <TopicMessages topic={TOPIC_B} />
      </Provider>
    )

    // 旧实现：`topic` 仍是 A，第一帧渲染 A 的消息；且因 A 有消息，"空历史"与"继续对话"
    // 的判断都基于上一条话题。
    expect(screen.queryByTestId('message-item')).toBeNull()
    expect(screen.getByTestId('history-topic-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('history-topic-error')).toBeNull()

    pending.resolve({ ...TOPIC_B, messages: [message('b-1')] })
    await waitFor(() => expect(screen.getByTestId('message-item')).toHaveTextContent('b-1'))
    expect(screen.queryByTestId('history-topic-loading')).toBeNull()
  })

  it('取数失败：渲染错误态 + 重试入口 + toast，不得伪装成"没有消息"', async () => {
    getTopicById.mockRejectedValueOnce(new Error('kernel not booted'))

    renderPanel(TOPIC_A)

    // 文案键 `history.load_failed` 由 i18n 键流程落盘（本轮不改 locale），因此只断言结构：
    // 错误条存在、带重试按钮、且**不是**空态。
    const errorState = await screen.findByTestId('history-topic-error')
    expect(errorState.querySelector('button')).not.toBeNull()
    expect(screen.queryByTestId('history-topic-loading')).toBeNull()
    expect(document.querySelector('.ant-empty')).toBeNull()
    expect(toastError).toHaveBeenCalledTimes(1)

    // 重试：这次成功 → 错误态消失并渲染消息。
    getTopicById.mockResolvedValueOnce({ ...TOPIC_A, messages: [message('a-2')] })
    ;(errorState.querySelector('button') as HTMLButtonElement).click()
    await waitFor(() => expect(screen.getByTestId('message-item')).toHaveTextContent('a-2'))
    expect(screen.queryByTestId('history-topic-error')).toBeNull()
  })

  it('取数成功但消息为空：渲染真正的空态', async () => {
    getTopicById.mockResolvedValueOnce({ ...TOPIC_A, messages: [] })

    renderPanel(TOPIC_A)

    await waitFor(() => expect(screen.queryByTestId('history-topic-loading')).toBeNull())
    expect(screen.queryByTestId('history-topic-error')).toBeNull()
    expect(document.querySelector('.ant-empty')).not.toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('store 里查不到话题行（getTopicById 返回空壳）时按失败处理，不渲染空历史', async () => {
    // `getTopicById` 用 spread 组装：topic 行不存在时得到的是 `{ messages: [...] }` 这样的空壳。
    getTopicById.mockResolvedValueOnce({ messages: [] } as unknown as Topic)

    renderPanel(TOPIC_A)

    expect(await screen.findByTestId('history-topic-error')).toBeInTheDocument()
    expect(document.querySelector('.ant-empty')).toBeNull()
  })

  it('生成中点击「继续对话」：isGenerating() 返回 false 即不切页（返回值语义）', async () => {
    getTopicById.mockResolvedValueOnce({ ...TOPIC_A, messages: [message('a-1')] })
    renderPanel(TOPIC_A)
    await waitFor(() => expect(screen.getByTestId('message-item')).toHaveTextContent('a-1'))

    // 每条消息自带的「定位」按钮只有图标、没有文本；「继续对话」是唯一带文本的按钮。
    const continueButton = screen.getAllByRole('button').find((button) => button.textContent) as HTMLButtonElement
    expect(continueButton).toBeDefined()

    // 旧写法只 `await isGenerating()` 不读结果：下面这条断言在旧实现下会红（`navigate` 已被调用）。
    vi.mocked(isGenerating).mockResolvedValueOnce(false)
    fireEvent.click(continueButton)
    await waitFor(() => expect(isGenerating).toHaveBeenCalledTimes(1))
    expect(NavigationService.navigate).not.toHaveBeenCalled()
    expect(SearchPopup.hide).not.toHaveBeenCalled()

    // 未生成：闸门返回 true → 正常切页。
    vi.mocked(isGenerating).mockResolvedValueOnce(true)
    fireEvent.click(continueButton)
    await waitFor(() => expect(NavigationService.navigate).toHaveBeenCalledTimes(1))
    expect(SearchPopup.hide).toHaveBeenCalledTimes(1)
  })
})
