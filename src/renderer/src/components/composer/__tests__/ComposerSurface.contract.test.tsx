/**
 * c2-08 / c2-14 行为测试：作曲条的高度契约与拖拽监听清理。
 *
 * c2-08 原状：`useComposerEditorFrameSizing` 发布的高度契约（`--composer-editor-max-height` 等）
 * 在 `src` 下零消费方，承载高度契约的只有 `textarea` 的 `rows={1}` —— 输入长草稿既不会自动增高，
 * 也不会在封顶高度后滚动。
 * c2-14 原状：拖拽调高的两条 window 监听在 mousedown 回调里注册，没有任何卸载清理。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import ComposerSurface from '../ComposerSurface'
import { getComposerEditorContentStyle } from '../useComposerEditorFrameSizing'

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelReservedSymbol: { QuickPhrases: 'quick-phrases' },
  QuickPanelView: () => null,
  useQuickPanel: () => ({ open: vi.fn() })
}))

vi.mock('@renderer/services/QuickPhraseService', () => ({
  default: { getAll: vi.fn().mockResolvedValue([]) }
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: { handlePaste: vi.fn() }
}))

const Host = ({ initialText, isExpanded = false }: { initialText: string; isExpanded?: boolean }) => {
  const [text, setText] = useState(initialText)

  return (
    <ComposerSurface
      text={text}
      onTextChange={setText}
      tokens={[]}
      managedTokenKinds={[]}
      onTokensChange={vi.fn()}
      placeholder="p"
      sendDisabled
      isLoading={false}
      onSendDraft={vi.fn()}
      onPause={vi.fn()}
      supportedExts={['.png']}
      setFiles={vi.fn()}
      filesCount={0}
      isExpanded={isExpanded}
      onExpandedChange={vi.fn()}
      quickPanelEnabled={false}
      enableDragDrop={false}
      enableSpellCheck={false}
      fontSize={14}
      narrowMode={false}
    />
  )
}

describe('composer editor height contract (c2-08)', () => {
  it('publishes a max-height variable for both collapsed and expanded modes', () => {
    const collapsed = getComposerEditorContentStyle(14, false, null)
    const expanded = getComposerEditorContentStyle(14, true, null)

    expect(collapsed['--composer-editor-max-height']).toBe('max(220px, 40vh)')
    expect(expanded['--composer-editor-max-height']).toBe('max(220px, 50vh)')
    expect(getComposerEditorContentStyle(14, false, 320)['--composer-editor-max-height']).toBe('320px')
  })

  it('makes the textarea consume the published max-height contract', () => {
    render(<Host initialText="" />)

    const textarea = screen.getByRole('textbox')
    expect(textarea.style.maxHeight).toBe('var(--composer-editor-max-height)')
  })

  it('grows the textarea with the draft and falls back to 100% when the frame owns the height', () => {
    const { rerender } = render(<Host initialText="" />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    // jsdom 里 scrollHeight 恒为 0；用可控的 getter 模拟「内容变长」。
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 137 })

    fireEvent.change(textarea, { target: { value: 'line1\nline2' } })

    expect(textarea.style.height).toBe('137px')

    rerender(<Host initialText="line1\nline2" isExpanded />)
    // 展开态由 frame 的固定高度决定，编辑区回落到 100%，不再自增高。
    expect(screen.getByRole('textbox').style.height).toBe('100%')
  })
})

describe('composer resize drag listeners (c2-14)', () => {
  it('removes the window listeners when the composer unmounts mid-drag', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { unmount } = render(<Host initialText="" />)
    const handle = document.querySelector('[data-composer-resize-handle]') as HTMLElement
    expect(handle).not.toBeNull()

    fireEvent.mouseDown(handle, { clientY: 100 })
    expect(addSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(addSpy).toHaveBeenCalledWith('mouseup', expect.any(Function))

    unmount()

    const removed = removeSpy.mock.calls.map(([type]) => type)
    expect(removed).toContain('mousemove')
    expect(removed).toContain('mouseup')

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
