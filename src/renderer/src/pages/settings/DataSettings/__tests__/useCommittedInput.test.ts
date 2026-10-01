import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useCommittedInput } from '../useCommittedInput'

/**
 * 输入框草稿的提交时机。
 *
 * `settings` 切片是 redux-persist 持久化的且没有节流：`onChange` 里直接 dispatch 等于每敲一个
 * 字符就整片序列化 + 写 localStorage。这个 hook 是四处同步面板（Joplin / Notion / Siyuan / Yuque）
 * 共用的提交契约：打字只改本地草稿，失焦才提交一次，且值没变就不写。
 */

const change = (value: string) => ({ target: { value } })

describe('useCommittedInput', () => {
  it('打字不提交，失焦才提交一次', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCommittedInput('old', commit))

    act(() => {
      result.current.onChange(change('o'))
      result.current.onChange(change('ol'))
      result.current.onChange(change('old-key'))
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.value).toBe('old-key')

    act(() => {
      result.current.onBlur(change('old-key'))
    })

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('old-key')
  })

  it('值没变时不写（点一下输入框再离开不产生整片持久化）', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCommittedInput('same', commit))

    act(() => {
      result.current.onBlur(change('same'))
    })

    expect(commit).not.toHaveBeenCalled()
  })

  it('未编辑时跟随外部真值（外部改动不被本地草稿挡住）', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(({ value }) => useCommittedInput(value, commit), {
      initialProps: { value: 'a' }
    })

    expect(result.current.value).toBe('a')

    rerender({ value: 'b' })
    expect(result.current.value).toBe('b')
  })

  it('空值也照常提交（清空是用户的意图，不是「没变」）', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCommittedInput('non-empty', commit))

    act(() => {
      result.current.onBlur(change(''))
    })

    expect(commit).toHaveBeenCalledWith('')
  })
})
