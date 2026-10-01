/**
 * 翻译页的两条失败语义。
 *
 * 缺陷形态：`loadHistory` 的 catch 只 `logger.warn`，抽屉消费侧是
 * `items.length === 0 ? <Empty description={t('translate.history_empty')} /> : …`——Dexie 打不开/
 * 表结构不符时用户看到官方的"暂无翻译记录"空态，会以为真的没有记录（本地历史是唯一副本），
 * 进而重复翻译或误判数据丢失。「A failure must never look like an empty result」。
 *
 * 缺陷形态：卸载守卫（`cancelledRef`）只覆盖事件回调与成功/失败分支，漏掉 `finally`——
 * 翻译进行中切走路由（懒加载页面，卸载很常见）后，流结束仍在已卸载组件上 `setTranslating(false)`。
 *
 * 行为级断言：① 历史读取失败 → 抽屉渲染错误态 + 重试按钮，且**不**渲染 `history_empty` 空态；
 * ② 卸载后流结束不再写状态（React 报 "not wrapped in act" / 卸载组件 setState 告警）。
 */
import '@renderer/i18n'

import store from '@renderer/store'
import { setTranslateModel } from '@renderer/store/llm'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toArray, lightStream } = vi.hoisted(() => ({ toArray: vi.fn(async () => []), lightStream: vi.fn() }))

vi.mock('@renderer/databases', () => ({
  db: {
    translate_records: {
      orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray }) }) }),
      put: vi.fn()
    }
  }
}))

vi.mock('@renderer/services/lightLlm', () => ({ lightStream, lightStreamAbort: vi.fn() }))

vi.mock('@renderer/components/Popups/SelectModelPopup/chat-model-popup', () => ({
  SelectChatModelPopup: { show: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  NavbarCenter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

import TranslatePage from '../TranslatePage'

function renderPage() {
  return render(
    <Provider store={store}>
      <TranslatePage />
    </Provider>
  )
}

describe('TranslatePage 失败语义', () => {
  beforeEach(() => {
    toArray.mockReset()
    lightStream.mockReset()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api?: Record<string, unknown> }).api,
      isFullScreen: vi.fn().mockResolvedValue(false)
    }
    ;(window as unknown as { toast: unknown }).toast = {
      error: vi.fn(),
      warning: vi.fn(),
      success: vi.fn(),
      info: vi.fn()
    }
  })

  it('历史读取失败渲染错误态 + 重试，而不是"暂无翻译记录"', async () => {
    toArray.mockRejectedValueOnce(new Error('IndexedDB open failed'))

    const { container } = renderPage()
    await waitFor(() => {
      expect(toArray).toHaveBeenCalled()
    })

    const historyButton = container.querySelector('[aria-pressed]')
    if (!historyButton) throw new Error('history button not found')
    fireEvent.click(historyButton)

    const errorState = await screen.findByTestId('translate-history-error')
    // 与空态分离：不得出现 history_empty 文案。
    expect(errorState.textContent).toContain('Failed to load translation history')
    expect(errorState.querySelector('button')).not.toBeNull()
    expect(screen.queryByText('No translation records')).toBeNull()
  })

  it('历史读取成功且 0 条：仍然渲染空态（不误报失败）', async () => {
    toArray.mockResolvedValueOnce([])

    const { container } = renderPage()
    await waitFor(() => {
      expect(toArray).toHaveBeenCalled()
    })

    fireEvent.click(container.querySelector('[aria-pressed]') as HTMLElement)
    await waitFor(() => {
      expect(screen.queryByTestId('translate-history-error')).toBeNull()
    })
    expect(screen.getAllByText('No translation records').length).toBeGreaterThan(0)
  })

  it('卸载后流结束不再写状态', async () => {
    toArray.mockResolvedValue([])
    let releaseStream: () => void = () => {}
    lightStream.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStream = resolve
        })
    )

    // 页面在没有配置翻译模型时会直接 toast 返回、根本进不到流；这里补一个可用的模型。
    const firstProvider = store.getState().llm.providers[0]
    const firstModel = firstProvider?.models[0]
    if (!firstProvider || !firstModel) throw new Error('no provider/model in test store')
    store.dispatch(setTranslateModel({ model: { ...firstModel, provider: firstProvider.id } }))
    // 模型头像等展示层会问 matchMedia（jsdom 无实现）。
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )

    const { container, unmount } = renderPage()
    await waitFor(() => {
      expect(toArray).toHaveBeenCalled()
    })

    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('input textarea not found')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await waitFor(() => {
      expect(lightStream).toHaveBeenCalled()
    })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    unmount()
    await act(async () => {
      releaseStream()
      await Promise.resolve()
    })

    // 卸载后不再写状态：React 不得报"更新已卸载组件"。
    const warnings = consoleError.mock.calls.map((call) => String(call[0]))
    expect(warnings.filter((text) => text.includes('unmounted component'))).toEqual([])
    consoleError.mockRestore()
  })
})
