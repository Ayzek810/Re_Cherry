/**
 * LinkEditor 的全局 mousedown 不能在清理之后才注册。
 *
 * 缺陷原状：监听器被 setTimeout(…, 100) 推迟注册，而 cleanup 是同步的。
 * 只要 visible 在 100ms 内变 false，cleanup 会在监听器尚不存在时执行，
 * 随后挂起的定时器把它永久留在 document 上 —— 之后任意点击都会调用已卸载组件的 onCancel。
 */
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import LinkEditor from '../components/LinkEditor'

const baseProps = {
  position: { x: 0, y: 0 },
  link: { href: 'https://example.com', text: 'link' },
  onSave: vi.fn(),
  onRemove: vi.fn()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LinkEditor outside-click listener', () => {
  it('does not leave a stranded document listener when it closes inside the guard window', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { rerender, unmount } = render(<LinkEditor {...baseProps} visible onCancel={onCancel} />)

    // 打开后 100ms 内立刻关闭：cleanup 在监听器注册之前发生。
    rerender(<LinkEditor {...baseProps} visible={false} onCancel={onCancel} />)
    act(() => {
      vi.advanceTimersByTime(500)
    })

    fireEvent.mouseDown(document.body)
    expect(onCancel).not.toHaveBeenCalled()

    unmount()
    fireEvent.mouseDown(document.body)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('still cancels on an outside click once the editor is open', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { unmount } = render(<LinkEditor {...baseProps} visible onCancel={onCancel} />)

    // 打开瞬间的那一下点击必须被吞掉，不能一开就关。
    fireEvent.mouseDown(document.body)
    expect(onCancel).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(120)
    })

    fireEvent.mouseDown(document.body)
    expect(onCancel).toHaveBeenCalledTimes(1)

    unmount()
  })
})
