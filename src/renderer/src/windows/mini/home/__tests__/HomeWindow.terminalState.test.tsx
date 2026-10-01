/**
 * r2-02 行为回归：快捷助手发送失败的**任何**路径都必须收敛终态。
 *
 * 缺陷：`handleSendMessage` 的终态收敛（`finishError` → 消息/块落 ERROR + `setIsOutputted(true)`）
 * 声明在 try 内，catch 只走 `handleError`（`setIsLoading(false)` + `setError`）。而「未配置快捷助手
 * 模型」这条最常见的失败 throw 在**助手消息已落库（PENDING）之后**，于是 store 里留下一条永为
 * PENDING 的助手消息，`Messages.tsx` 的 `{!isOutputted && <LoadingOutlined spin />}` 无限转圈——
 * 失败看起来像"还在生成"。
 *
 * 本测试用真 store（真 reducer）+ 真 `getAssistantMessage`/`getUserMessage`，把 ChatWindow 换成
 * 只暴露 `isOutputted` 的探针（它就是驱动转圈动画的那个 prop），断言两条失败路径都收敛：
 *   ① 未配模型（throw 在回复块建立之前）；② 传输通道 reject（回复块已 STREAMING）。
 */
import '@renderer/i18n'

import { lightStream } from '@renderer/services/lightLlm'
import store from '@renderer/store'
import { setQuickAssistantModel, setTranslateModel } from '@renderer/store/llm'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus } from '@renderer/types/newMessage'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import HomeWindow from '../HomeWindow'

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

vi.mock('@renderer/services/lightLlm', () => ({
  lightStream: vi.fn(),
  lightStreamAbort: vi.fn().mockResolvedValue(undefined)
}))

/** 探针：ChatWindow 原本渲染整棵 Messages 树；这里只暴露驱动加载动画的 `isOutputted`。 */
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

describe('HomeWindow · r2-02 发送失败必收敛终态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.dispatch(setQuickAssistantModel({ model: undefined }))
    store.dispatch(setTranslateModel({ model: undefined }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api?: Record<string, unknown> }).api,
      miniWindow: { setPin: vi.fn().mockResolvedValue(undefined), hide: vi.fn() },
      // HomeWindow 挂载时会订阅「窗口显示」事件；未 stub 时渲染期直接
      // `Cannot read properties of undefined (reading 'onShowMiniWindow')`（f2 遗留的测试桩缺口）。
      events: { onShowMiniWindow: vi.fn(() => () => {}) }
    }
    const ipcRenderer = (window as unknown as { electron: { ipcRenderer: Record<string, unknown> } }).electron
      .ipcRenderer
    ipcRenderer.on = vi.fn()
    ipcRenderer.removeListener = vi.fn()
    ;(window as unknown as { toast: Record<string, unknown> }).toast = {
      info: vi.fn(),
      error: vi.fn(),
      success: vi.fn()
    }
  })

  it('未配快捷助手模型：助手消息落 ERROR、加载动画停止（不留 PENDING + 无限转圈）', async () => {
    renderWindow()
    await sendWithEnter('hello')

    await waitFor(() => {
      expect(lastAssistantMessage()?.status).toBe(AssistantMessageStatus.ERROR)
    })
    // 修复前：状态恒为 PENDING（getAssistantMessage 的缺省）、isOutputted 恒为 false。
    expect(screen.getByTestId('chat-window')).toHaveAttribute('data-outputted', 'true')
    // 失败必须对用户可见，不能只打日志。
    expect(screen.getByText('Quick assistant model is not configured')).toBeInTheDocument()
  })

  it('传输通道 reject：助手消息与回复块都落 ERROR，加载动画停止', async () => {
    store.dispatch(setQuickAssistantModel({ model: MODEL as never }))
    vi.mocked(lightStream).mockRejectedValue(new Error('channel down'))

    renderWindow()
    await sendWithEnter('hello')

    await waitFor(() => {
      expect(lastAssistantMessage()?.status).toBe(AssistantMessageStatus.ERROR)
    })
    const assistant = lastAssistantMessage()
    const replyBlockId = assistant?.blocks?.[0]
    expect(replyBlockId).toBeDefined()
    expect(store.getState().messageBlocks.entities[replyBlockId as string]?.status).toBe(MessageBlockStatus.ERROR)
    expect(screen.getByTestId('chat-window')).toHaveAttribute('data-outputted', 'true')
  })
})
