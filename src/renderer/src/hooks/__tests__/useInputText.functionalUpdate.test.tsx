/**
 * `useInputText` 的函数式更新走 React 的 updater 语义。
 *
 * 改动前 `const newText = typeof value === 'function' ? value(text) : value` 读渲染期闭包：
 * 同一 tick 的两次函数式更新都基于同一个旧 `text` 计算，第二次覆盖第一次（丢更新）。
 * 对外类型是 `React.SetStateAction<string>`，消费方（`useMentionModelsPanel`）确实按
 * updater 使用，所以丢更新是可见缺陷。
 *
 * 断言：同一 tick 两次函数式更新依次作用；`prevText`/`onChange` 语义不变（onChange 收到
 * 最终值）。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useInputText } from '../useInputText'

describe('useInputText ：React updater 语义', () => {
  it('同一 tick 的两次函数式更新依次作用（不再丢更新）', () => {
    const { result } = renderHook(() => useInputText({ initialValue: 'a' }))

    act(() => {
      result.current.setText((prev) => `${prev}b`)
      result.current.setText((prev) => `${prev}c`)
    })

    expect(result.current.text).toBe('abc')
  })

  it('prevText 与 onChange 语义不变', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useInputText({ initialValue: 'x', onChange }))

    act(() => result.current.setText('y'))
    expect(result.current.text).toBe('y')
    expect(result.current.prevText).toBe('x')
    expect(onChange).toHaveBeenLastCalledWith('y')

    act(() => result.current.setText((prev) => `${prev}z`))
    expect(result.current.text).toBe('yz')
    expect(result.current.prevText).toBe('y')
    expect(onChange).toHaveBeenLastCalledWith('yz')
  })

  it('clear 仍然清空且触发 onChange', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useInputText({ initialValue: 'draft', onChange }))

    act(() => result.current.clear())

    expect(result.current.text).toBe('')
    expect(result.current.isEmpty).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith('')
  })
})
