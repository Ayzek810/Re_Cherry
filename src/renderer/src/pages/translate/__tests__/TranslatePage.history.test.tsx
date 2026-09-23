/**
 * 翻译页历史回填契约测试。
 *
 * 行为级验证（§4.18）：V2 `pages/translate/TranslatePage.tsx:573-602` —— 点历史记录除了回填
 * 两个文本窗，还要恢复记录的 source/target 语言（fork 此前只回填文本，语言对停在当前选择）。
 * 观察窗 = 语言栏：把页面真传下去的 `source`/`target` 与回填回调暴露出来，并对回填回调喂
 * 一条带语言对的历史记录，断言语言栏状态随之改变（不 mock 页面自身逻辑）。
 */
import '@renderer/i18n'

import store from '@renderer/store'
import type { TranslateRecord } from '@renderer/types/translate'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TranslatePage from '../TranslatePage'

const records: TranslateRecord[] = []

vi.mock('@renderer/databases', () => ({
  db: {
    translate_records: {
      orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => records }) }) })
    }
  }
}))

vi.mock('@renderer/services/lightLlm', () => ({
  lightStream: vi.fn(),
  lightStreamAbort: vi.fn()
}))

vi.mock('@renderer/components/Popups/SelectModelPopup/chat-model-popup', () => ({
  SelectChatModelPopup: { show: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  NavbarCenter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('../components/TranslateLanguageBar', () => ({
  default: (props: { source: string; target: string; onSourceChange: (value: string) => void }) => (
    <>
      <div data-testid="language-bar" data-source={props.source} data-target={props.target} />
      {/* 回填语言对走页面真实回调；按钮只是把「历史的 sourceLanguage」喂进去。 */}
      <button type="button" data-testid="restore-source" onClick={() => props.onSourceChange('en-us')} />
    </>
  )
}))

const HISTORY_RECORD: TranslateRecord = {
  id: 'h1',
  sourceText: 'hello world',
  targetText: '你好，世界',
  sourceLanguage: 'en-us',
  targetLanguage: 'ja-jp',
  createdAt: Date.now()
}

describe('TranslatePage · 历史回填', () => {
  beforeEach(() => {
    records.length = 0
    records.push(HISTORY_RECORD)
    // Navbar 挂载时会问全屏状态（useFullscreen）。
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...((window as unknown as { api?: Record<string, unknown> }).api ?? {}),
      isFullScreen: vi.fn().mockResolvedValue(false)
    }
  })

  it('点历史记录同时恢复文本与语言对，并收起抽屉', async () => {
    const { container } = render(
      <Provider store={store}>
        <TranslatePage />
      </Provider>
    )

    // 初始：源 auto / 目标 zh-cn。
    await waitFor(() => expect(screen.getByTestId('language-bar').dataset.source).toBe('auto'))
    expect(screen.getByTestId('language-bar').dataset.target).toBe('zh-cn')

    // 打开历史抽屉（顶栏第一个带 aria-pressed 的按钮 = 历史；文案随 i18n 语言变化，故不按名字定位）。
    const historyButton = container.querySelector('[aria-pressed]')
    if (!historyButton) throw new Error('history button not found')
    fireEvent.click(historyButton)
    fireEvent.click(await screen.findByText('hello world'))

    // 语言对随记录恢复（fork 缺陷：此前只回填文本，这里仍是 auto/zh-cn）。
    await waitFor(() => expect(screen.getByTestId('language-bar').dataset.source).toBe('en-us'))
    expect(screen.getByTestId('language-bar').dataset.target).toBe('ja-jp')
    // 两个文本窗一并回填（左栏是 textarea；右栏是只读渲染块——历史抽屉里也有一份同样的
    // 译文，antd Drawer 关闭后节点仍在 DOM，故用 getAllByText）。
    expect(screen.getByDisplayValue('hello world')).toBeInTheDocument()
    expect(screen.getAllByText('你好，世界').length).toBeGreaterThan(0)
  })
})
