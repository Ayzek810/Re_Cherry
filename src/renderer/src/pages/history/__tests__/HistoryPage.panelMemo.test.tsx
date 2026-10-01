/**
 * 二轮审查 f2-58 / f2-60：`HistoryPage` 用内联对象与组件体内的箭头函数给面板传参，`memo(SearchResults)`
 * 完全失效；并且用"给 `keywords` 喂空串"来表达"面板当前不可见"。
 *
 * 观察窗（provable，不依赖对测试库行为的猜测）：
 *   · 话题列表与搜索面板用**真实实现**渲染；
 *   · `SearchResults` 的替身**刻意不包 `memo`**，因此"最后一次收到的 props 对象"与上一次是同一个引用
 *     ⇔ 父组件那一次渲染没有重渲染它（旧实现在这里必然产生新对象）；
 *   · `TopicMessages` / `SearchMessage` 用替身记录最后一次 props（`style` 引用稳定 = memo 可比较）。
 */
import '@renderer/i18n'

import store from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ containerRef: { current: null }, handleScroll: () => {} })
}))

// 点进消息会 dispatch 内核加载 thunk（→ IPC）。本测试只关心页面传下去的 props，不需要真的取数。
// X14：thunk 现在总返回 Promise（`loadTopicMessagesThunk` 的早退分支改 `return Promise.resolve()`），
// 消费方 `HistoryPage.tsx` 直接 `dispatch(...).catch(...)` —— 桩必须返回 thenable，否则得到
// `TypeError: dispatch(...).catch is not a function`（与运行期契约不符的假失败）。
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  loadTopicMessagesThunk: (topicId: string) => async () => ({ type: 'test/loadTopicMessages', topicId })
}))

const searchResultsProps: Array<Record<string, unknown>> = []
vi.mock('../../history/components/SearchResults', () => ({
  default: (props: Record<string, unknown>) => {
    searchResultsProps.push(props)
    return <div data-testid="search-panel" />
  }
}))

const topicMessagesProps: Array<Record<string, unknown>> = []
vi.mock('../../history/components/TopicMessages', () => ({
  default: (props: Record<string, unknown>) => {
    topicMessagesProps.push(props)
    return <div data-testid="topic-panel" />
  }
}))

const searchMessageProps: Array<Record<string, unknown>> = []
vi.mock('../../history/components/SearchMessage', () => ({
  default: (props: Record<string, unknown>) => {
    searchMessageProps.push(props)
    return <div data-testid="message-panel" />
  }
}))

import HistoryPage from '../HistoryPage'

const SEARCH_MESSAGE = { id: 'm-1', topicId: 'topic-1' } as Message

function renderPage() {
  return render(
    <Provider store={store}>
      <HistoryPage />
    </Provider>
  )
}

describe('HistoryPage 面板传参稳定性（f2-58）与检索入参保留（f2-60）', () => {
  beforeEach(() => {
    searchResultsProps.length = 0
    topicMessagesProps.length = 0
    searchMessageProps.length = 0
    ;(window as unknown as { api: unknown }).api = { dshSearchMessages: vi.fn() }
    ;(window as unknown as { toast: unknown }).toast = {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    }
  })

  it('搜索框输入不改动 `SearchResults` 的任何 prop 值（memo 的比较基准全部稳定）', () => {
    renderPage()
    const before = searchResultsProps.at(-1)
    expect(before).toBeDefined()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'kernel' } })

    const after = searchResultsProps.at(-1)
    // 逐项按引用比对：`style` 与两个回调都不再内联新建（旧实现三项全变，`memo` 必然击穿）；
    // `keywords` 只在提交检索时更新，输入过程不动它 —— 这正是 f2-60 的前提。
    expect(after?.style).toBe(before?.style)
    expect(after?.onMessageClick).toBe(before?.onMessageClick)
    expect(after?.onTopicClick).toBe(before?.onTopicClick)
    expect(after?.keywords).toBe(before?.keywords)
    expect(after?.visible).toBe(before?.visible)
  })

  it('输入只牵动话题列表；`TopicMessages` / `SearchMessage` 的 style 引用保持稳定', () => {
    renderPage()
    const topicStyle = topicMessagesProps.at(-1)?.style
    const messageStyle = searchMessageProps.at(-1)?.style
    const topicCount = topicMessagesProps.length
    expect(topicStyle).toBeDefined()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'kernel' } })

    // 这两个面板没包 memo（改动范围之外），退一级断言：`style` 引用必须稳定，
    // 否则父组件每一次输入都会连带它们重渲染。
    expect(topicMessagesProps.length).toBe(topicCount)
    expect(topicMessagesProps.at(-1)?.style).toBe(topicStyle)
    expect(searchMessageProps.at(-1)?.style).toBe(messageStyle)
  })

  it('进入消息视图：搜索面板保留 `keywords`，只把 `visible` 置 false（f2-60）', async () => {
    renderPage()

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'kernel' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    const searchVisible = searchResultsProps.at(-1)
    expect(searchVisible?.keywords).toBe('kernel')
    expect(searchVisible?.visible).toBe(true)

    // 从搜索结果点进某条消息：stack 变 ['topics','search','message']。
    const onMessageClick = searchVisible?.onMessageClick as (message: Message) => void
    expect(() => onMessageClick(SEARCH_MESSAGE)).not.toThrow()

    await waitFor(() => expect(searchResultsProps.at(-1)?.visible).toBe(false))
    // 旧实现在这条路径上把 keywords 置成 `''`：结果与高亮词被清空，返回搜索视图时 keywords
    // 复原 → `onSearch` 重跑一次内核检索并闪一次 spinner。
    expect(searchResultsProps.at(-1)?.keywords).toBe('kernel')
  })
})
