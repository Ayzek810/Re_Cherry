/**
 * 两处交互契约。
 *
 * `ConfirmDialog` 用一个只比对话框低一层的全屏透明遮罩承担「点击外部取消」——
 *        对话框可见期间页面上任何其他交互都会先命中遮罩并直接触发 `onCancel`。
 * `EditableNumber` 非编辑态只是 `opacity: 0`（仍可 Tab 聚焦、仍接收键盘输入）；
 *        Enter 手动调 `handleBlur()` 之后真实 blur 会再通知一次 `onBlur`。
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ConfirmDialog from '../ConfirmDialog'
import EditableNumber from '../EditableNumber'

describe('ConfirmDialog outside-click', () => {
  it('does not render a full-screen overlay that swallows other interactions', () => {
    render(<ConfirmDialog x={10} y={10} message="delete?" onConfirm={vi.fn()} onCancel={vi.fn()} />)

    // 对话框经 createPortal 挂在 body 上。
    const dialog = document.querySelector('.z-\\[99999\\]') as HTMLElement
    expect(dialog).not.toBeNull()
    // 原来的全屏透明遮罩（`.fixed.inset-0`）已删除。
    expect(document.body.querySelectorAll('.fixed.inset-0')).toHaveLength(0)
    expect(dialog.textContent).toContain('delete?')
  })

  it('cancels when a mousedown lands outside the dialog and ignores clicks inside', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(<ConfirmDialog x={10} y={10} message="delete?" onConfirm={onConfirm} onCancel={onCancel} />)

    const dialog = document.querySelector('.z-\\[99999\\]') as HTMLElement
    fireEvent.mouseDown(dialog)
    expect(onCancel).not.toHaveBeenCalled()

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    fireEvent.mouseDown(outside)
    expect(onCancel).toHaveBeenCalledTimes(1)

    outside.remove()
  })
})

describe('EditableNumber interaction contract', () => {
  const numberInput = () => document.querySelector('input') as HTMLInputElement

  it('takes the hidden input out of the tab order and out of view', () => {
    render(<EditableNumber value={12} onChange={vi.fn()} />)

    const input = numberInput()
    const wrapper = document.querySelector('.ant-input-number') as HTMLElement
    expect(input).not.toBeNull()
    expect(input).toHaveAttribute('tabindex', '-1')
    expect(wrapper.style.visibility).toBe('hidden')

    fireEvent.focus(input)
    expect(wrapper.style.visibility).toBe('visible')
    expect(input).toHaveAttribute('tabindex', '0')
  })

  it('notifies onBlur exactly once for a single edit session finished with Enter', () => {
    const onBlur = vi.fn()
    render(<EditableNumber value={12} onChange={vi.fn()} onBlur={onBlur} />)

    const input = numberInput()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Enter' })

    // Enter 之后紧接着到来的真实 blur 事件不得再通知一次调用方（否则重复提交）。
    fireEvent.blur(input)

    expect(onBlur).toHaveBeenCalledTimes(1)
  })

  it('treats a plain blur without Enter as one notification as well', () => {
    const onBlur = vi.fn()
    render(<EditableNumber value={12} onChange={vi.fn()} onBlur={onBlur} />)

    const input = numberInput()
    fireEvent.focus(input)
    fireEvent.blur(input)
    fireEvent.blur(input)

    expect(onBlur).toHaveBeenCalledTimes(1)
  })
})
