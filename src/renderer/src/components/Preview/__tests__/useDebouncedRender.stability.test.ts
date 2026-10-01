/**
 * c2-09 行为测试：预览防抖渲染的两处缺陷。
 *
 * 原状：
 *  ① `triggerRender` 同步打开 spinner，但真正的渲染排在防抖之后；`debouncedRender` 依赖
 *     `wrappedRenderFunction`（后者依赖 `shouldRender`/`renderFunction`），预览组件在防抖窗口内
 *     任何一次重渲染都会重建它 → `triggerRender`/`cancelRender` 身份变化 → effect cleanup 执行
 *     `cancelRender()`，把已排队的那次渲染丢掉。
 *  ② 守卫早退时没有任何分支复位 `triggerRender` 已打开的 `isLoading`，折叠/`display:none` 里的
 *     图表走早退后 spinner 一直转。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDebouncedRender } from '../hooks/useDebouncedRender'

const createContainer = () => {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

describe('useDebouncedRender stability', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets isLoading when the render guard rejects the content', async () => {
    vi.useFakeTimers()
    const container = createContainer()
    const renderFunction = vi.fn().mockResolvedValue(undefined)
    const shouldRender = vi.fn(() => false)

    const { result } = renderHook(() =>
      useDebouncedRender('content', renderFunction, { debounceDelay: 300, shouldRender })
    )
    result.current.containerRef.current = container

    act(() => {
      result.current.triggerRender('content')
    })

    // 守卫早退：不能留下一个永远转圈的 spinner。
    expect(result.current.isLoading).toBe(false)
    expect(renderFunction).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.isLoading).toBe(false)
    expect(renderFunction).not.toHaveBeenCalled()

    container.remove()
  })

  it('keeps the queued render when the parent re-renders inside the debounce window', async () => {
    vi.useFakeTimers()
    const container = createContainer()
    const firstRender = vi.fn().mockResolvedValue(undefined)
    const secondRender = vi.fn().mockResolvedValue(undefined)

    const { result, rerender } = renderHook(
      ({ renderFn }) => useDebouncedRender('content', renderFn, { debounceDelay: 300 }),
      { initialProps: { renderFn: firstRender } }
    )
    result.current.containerRef.current = container

    act(() => {
      result.current.triggerRender('content')
    })

    // 防抖窗口内父组件重渲染 → renderFunction 身份变化。
    rerender({ renderFn: secondRender })

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    // 修复前：cleanup 里的 cancelRender() 会把排队的那次渲染丢掉，两个函数都不会被调用。
    expect(secondRender).toHaveBeenCalledWith('content', container)

    container.remove()
  })

  it('cancels the queued render on unmount', async () => {
    vi.useFakeTimers()
    const container = createContainer()
    const renderFunction = vi.fn().mockResolvedValue(undefined)

    const { result, unmount } = renderHook(() => useDebouncedRender('content', renderFunction, { debounceDelay: 300 }))
    result.current.containerRef.current = container

    act(() => {
      result.current.triggerRender('content')
    })

    unmount()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(renderFunction).not.toHaveBeenCalled()

    container.remove()
  })
})
