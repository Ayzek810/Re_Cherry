/**
 * mini 翻译窗口一轮翻译**只发一次**请求。
 *
 * 缺陷链条（修复前）：`useSmoothStream({ streamDone: !isTranslating })` 的 `reset` 依赖
 * `streamDone`，而 `streamDone` 由 `isTranslating` 推导 → 请求结束 `finally { setIsTranslating(false) }`
 * 翻转 `streamDone` → `reset` 换 identity → 翻译 effect 依赖数组变化 → cleanup `lightStreamAbort`
 * + 再发一次 `lightStream`……循环不止（译文被反复清空、模型费用无界）。
 *
 * 本测试用真 store + 真 `useSmoothStream`，只 mock 传输层 `lightStream`：断言一轮（delta + done）
 * 后调用次数恰为 1、旧流没有被 abort；第二条用例反向钉住「依赖数组没有被过度收窄」——
 * 文本变化仍必须重译（abort 旧流 + 再发一次）。
 */
import { lightStream, lightStreamAbort } from '@renderer/services/lightLlm'
import store from '@renderer/store'
import { setTranslateModel } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import type { LightLlmStreamEvent } from '@shared/lightLlm/types'
import { act, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TranslateWindow from '../TranslateWindow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/services/lightLlm', () => ({
  lightStream: vi.fn(),
  lightStreamAbort: vi.fn().mockResolvedValue(undefined)
}))

const MODEL: Model = {
  id: 'translate-model',
  provider: 'test-provider',
  name: 'Test Translate Model',
  group: 'test'
}

const emitEvents = (events: LightLlmStreamEvent[]) =>
  vi.mocked(lightStream).mockImplementation(async (_requestId, _call, onEvent) => {
    for (const event of events) onEvent(event)
    return { ok: true }
  })

const renderWindow = (text: string) =>
  render(
    <Provider store={store}>
      <TranslateWindow text={text} />
    </Provider>
  )

const flush = () =>
  act(async () => {
    await Promise.resolve()
  })

describe('TranslateWindow · 单次请求', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.dispatch(setTranslateModel({ model: MODEL }))
  })

  it('一轮翻译（delta + done）只发一次 lightStream，且不 abort 在途流', async () => {
    emitEvents([{ type: 'delta', text: '你好' }, { type: 'done' }])

    renderWindow('hello world')
    // 让流结束引发的终态更新（playout done）与随之而来的重渲染全部落地：
    // 修复前这一轮会因 `reset` 换 identity 再进一次 effect，调用次数变成 2 以上。
    await flush()
    await flush()

    expect(lightStream).toHaveBeenCalledTimes(1)
    expect(lightStreamAbort).not.toHaveBeenCalled()
    // 显式终态（update(text, true)）仍要把已收到的字符吐完：空态自旋与"文本丢失"都要排除。
    await waitFor(() => expect(screen.getByText('你好')).toBeInTheDocument())
    // 修复前这里是**永不收敛**的重入（`act` 排空微任务时无限循环），故给一条短超时：
    // 回归时以 5s 超时失败，而不是耗满全局 20s。
  }, 5000)

  it('文本变化仍重译：abort 旧流后恰好再发一次（依赖数组未被过度收窄）', async () => {
    emitEvents([{ type: 'delta', text: '你好' }, { type: 'done' }])

    const view = renderWindow('hello world')
    await flush()

    view.rerender(
      <Provider store={store}>
        <TranslateWindow text="another text" />
      </Provider>
    )
    await flush()
    await flush()

    expect(lightStream).toHaveBeenCalledTimes(2)
    expect(lightStreamAbort).toHaveBeenCalledTimes(1)
  }, 5000)
})
