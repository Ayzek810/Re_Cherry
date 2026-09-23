/**
 * 快捷助手首页「功能菜单」的发送契约（v0.3.3-1 修复"快速助手一直不出字"）。
 *
 * 真机症状：在四选项首页打字后按回车（或点「回答此问题」），只切到对话面板、**什么都不发**，
 * 用户看到的就是"快捷助手不能用"。根因是 v0.3.3-9 把发送条件收成 `if (prompt)`，而 chat 项
 * 在 V2 里本来就不带 prompt 也要发（V2 `FeatureMenus.tsx:36-41`：`setRoute('chat')` + `onSendMessage()`）。
 *
 * 本测试钉住四条：chat 无 prompt 也发；另三项带各自 prompt 发；空文本只切路由 + 提示；选项顺序不变。
 */
import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FeatureMenus, { type FeatureMenusRef } from '../FeatureMenus'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const prompts = { summarize: 'prompts.summarize', explanation: 'prompts.explanation' }

function renderMenus(text: string) {
  const onSendMessage = vi.fn()
  const setRoute = vi.fn()
  let ref: React.RefObject<FeatureMenusRef | null> = { current: null }
  const Harness = () => {
    const innerRef = useRef<FeatureMenusRef | null>(null)
    ref = innerRef
    return <FeatureMenus ref={innerRef} text={text} setRoute={setRoute} onSendMessage={onSendMessage} />
  }
  render(<Harness />)
  return { ref, onSendMessage, setRoute }
}

describe('FeatureMenus · 发送契约', () => {
  beforeEach(() => {
    window.toast = { info: vi.fn(), error: vi.fn(), success: vi.fn() } as never
  })

  it('「回答此问题」（chat）不带 prompt 也要发送（V2 同形）', () => {
    const { ref, onSendMessage, setRoute } = renderMenus('写了点东西')

    act(() => ref.current?.useFeature())

    expect(setRoute).toHaveBeenCalledWith('chat')
    // 关键断言：修复前这里是 0 次（只切面板不发请求）
    expect(onSendMessage).toHaveBeenCalledTimes(1)
    expect(onSendMessage).toHaveBeenCalledWith(undefined)
  })

  it('总结/解释带各自 prompt 发送；翻译只切路由（选项序：chat → translate → summary → explanation）', () => {
    const translate = renderMenus('正文')
    act(() => translate.ref.current?.nextFeature())
    act(() => translate.ref.current?.useFeature())
    expect(translate.setRoute).toHaveBeenCalledWith('translate')
    expect(translate.onSendMessage).not.toHaveBeenCalled()

    const summary = renderMenus('正文')
    act(() => summary.ref.current?.nextFeature())
    act(() => summary.ref.current?.nextFeature())
    act(() => summary.ref.current?.useFeature())
    expect(summary.setRoute).toHaveBeenCalledWith('summary')
    expect(summary.onSendMessage).toHaveBeenCalledWith(prompts.summarize)

    const explanation = renderMenus('正文')
    act(() => explanation.ref.current?.nextFeature())
    act(() => explanation.ref.current?.nextFeature())
    act(() => explanation.ref.current?.nextFeature())
    act(() => explanation.ref.current?.useFeature())
    expect(explanation.setRoute).toHaveBeenCalledWith('explanation')
    expect(explanation.onSendMessage).toHaveBeenCalledWith(prompts.explanation)
  })

  it('无文本时只切路由 + 提示，不发请求（保留 v0.3.3-9 的修复意图）', () => {
    const { ref, onSendMessage, setRoute } = renderMenus('')

    act(() => ref.current?.useFeature())

    expect(setRoute).toHaveBeenCalledWith('chat')
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(window.toast.info).toHaveBeenCalledWith('miniwindow.clipboard.empty')
  })
})
