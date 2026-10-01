import type { Assistant } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import ChatSettingsSection from '../ChatSettingsSection'

beforeAll(() => {
  // antd Slider/InputNumber 依赖 matchMedia（jsdom 未内置）
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

/**
 * 采样参数的落库时机契约（v1 二轮审查 s2-02）。
 *
 * 旧实现把写入排在 500ms/1000ms 的 `setTimeoutTimer` 上，而 `useTimer` 卸载时会
 * `clearAllTimers()`：改完参数立刻关弹窗 / 切 tab，界面看着改好了，写入却从未发生；
 * 「重置」也不清挂起的定时器，于是重置后旧值被反写。下面锁住修正后的语义。
 *
 * 用「上下文长度」这个始终渲染的数字框取值：温度 / topP 只在各自开关打开时才渲染。
 */

const assistant = (settings: Assistant['settings'] = {}): Assistant =>
  ({ id: 'a1', name: 'A', settings }) as unknown as Assistant

/** 上下文长度输入框：max 等于 MAX_CONTEXT_COUNT（100）。 */
const contextCountInput = () =>
  screen.getAllByRole('spinbutton').find((el) => el.getAttribute('aria-valuemax') === '100') as HTMLInputElement

describe('采样参数的延迟写入', () => {
  it('卸载时把还没落库的挂起值 flush 掉（关弹窗 / 切 tab 不丢写）', () => {
    const updateAssistantSettings = vi.fn()
    const { unmount } = render(
      <ChatSettingsSection assistant={assistant()} updateAssistantSettings={updateAssistantSettings} />
    )

    fireEvent.change(contextCountInput(), { target: { value: '42' } })
    expect(updateAssistantSettings).not.toHaveBeenCalledWith({ contextCount: 42 })

    unmount()

    expect(updateAssistantSettings).toHaveBeenCalledWith({ contextCount: 42 })
  })

  it('没有挂起写入时不产生多余的采样参数写入', () => {
    const updateAssistantSettings = vi.fn()
    const { unmount } = render(
      <ChatSettingsSection assistant={assistant()} updateAssistantSettings={updateAssistantSettings} />
    )

    unmount()

    expect(updateAssistantSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ contextCount: expect.anything() })
    )
  })

  it('点「重置」清掉挂起的定时器，挂起值不会在重置后反写', () => {
    vi.useFakeTimers()
    try {
      const updateAssistantSettings = vi.fn()
      render(<ChatSettingsSection assistant={assistant()} updateAssistantSettings={updateAssistantSettings} />)

      fireEvent.change(contextCountInput(), { target: { value: '7' } })
      fireEvent.click(screen.getByRole('button', { name: /reset|重置/i }))

      const callsAfterReset = updateAssistantSettings.mock.calls.length
      vi.advanceTimersByTime(2000)

      expect(updateAssistantSettings.mock.calls.length).toBe(callsAfterReset)
      expect(updateAssistantSettings).not.toHaveBeenCalledWith({ contextCount: 7 })
    } finally {
      vi.useRealTimers()
    }
  })
})
