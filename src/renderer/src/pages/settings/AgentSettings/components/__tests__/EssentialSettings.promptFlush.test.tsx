import '@renderer/i18n'

import type { Assistant } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 提示词草稿的卸载兜底（v1 二轮审查 s2-09）。
 *
 * 提示词编辑区只有区内那个「保存」键会提交，弹窗底部的「确认」只关窗（`BaseSettingsPopup`
 * 的 `handleConfirm` 不提交任何东西）。用户在编辑器里改完提示词直接按「确认」→ 组件卸载
 * →「新建助手」流程交回的草稿静默缺少提示词。下面锁住修正后的语义：改过就 flush，没改不写。
 */

vi.mock('@renderer/components/CodeEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea data-testid="prompt-editor" value={value} onChange={(event) => onChange(event.target.value)} />
  )
}))
vi.mock('@renderer/components/EmojiPicker', () => ({ default: () => <div /> }))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({ SelectChatModelPopup: { show: vi.fn() } }))
vi.mock('@renderer/hooks/useAssistantIdentityImage', () => ({ default: () => null }))
vi.mock('@renderer/hooks/usePromptProcessor', () => ({
  usePromptProcessor: ({ prompt }: { prompt: string }) => prompt
}))
vi.mock('@renderer/services/TokenService', () => ({ estimateTextTokens: () => 0 }))

import EssentialSettings from '../EssentialSettings'

beforeAll(() => {
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

const assistant = (prompt: string): Assistant =>
  ({ id: 'a1', name: 'A', emoji: '', prompt, settings: {} }) as unknown as Assistant

const renderEssentials = (prompt: string, updateAssistant = vi.fn()) => {
  const updateAssistantSettings = vi.fn()
  const view = render(
    <EssentialSettings
      assistant={assistant(prompt)}
      updateAssistant={updateAssistant}
      updateAssistantSettings={updateAssistantSettings}
    />
  )
  return { ...view, updateAssistant, updateAssistantSettings }
}

describe('提示词的提交时机', () => {
  beforeEach(() => {
    window.toast = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    } as unknown as typeof window.toast
  })

  it('改过提示词后卸载（＝按弹窗「确认」）会 flush 一次', () => {
    const { unmount, updateAssistant } = renderEssentials('old prompt')

    fireEvent.change(screen.getByTestId('prompt-editor'), { target: { value: 'new prompt' } })
    expect(updateAssistant).not.toHaveBeenCalled()

    unmount()

    expect(updateAssistant).toHaveBeenCalledWith({ prompt: 'new prompt' })
  })

  it('没改过就不写（避免每次关窗都重写助手）', () => {
    const { unmount, updateAssistant } = renderEssentials('old prompt')

    unmount()

    expect(updateAssistant).not.toHaveBeenCalled()
  })

  it('区内「保存」键提交后，卸载不再重复写同一个值', () => {
    const { unmount, updateAssistant, rerender } = renderEssentials('old prompt')

    fireEvent.change(screen.getByTestId('prompt-editor'), { target: { value: 'new prompt' } })
    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }))
    expect(updateAssistant).toHaveBeenCalledWith({ prompt: 'new prompt' })

    // 真实链路里父组件会用新助手重渲染（编辑既有助手写回 Redux / 草稿容器 setDraft）
    rerender(
      <EssentialSettings
        assistant={assistant('new prompt')}
        updateAssistant={updateAssistant}
        updateAssistantSettings={vi.fn()}
      />
    )
    updateAssistant.mockClear()

    unmount()

    expect(updateAssistant).not.toHaveBeenCalled()
  })
})
