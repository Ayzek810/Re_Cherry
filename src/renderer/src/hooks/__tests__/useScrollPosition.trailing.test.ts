/**
 * r2-35 行为测试：`useScrollPosition` 的 trailing 保存在消费方反复重渲染后仍然落盘。
 *
 * 改动前 `throttle(...)` 每次渲染都新建，cleanup effect 依赖这个新函数，于是每次渲染都
 * 跑一次 `handleScroll.cancel()`。聊天流式期间 `Messages.tsx` 逐帧重渲染，用户停下滚动时
 * 的那次 trailing 保存（"停下来的位置"）被系统性取消。
 *
 * 断言只看行为：多次重渲染之后推进节流窗口，trailing 仍以**当时**的 scrollTop 落盘；
 * 且 `throttleWait` 参数仍然决定触发时刻。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import useScrollPosition from '../useScrollPosition'

const keyvSet = vi.fn()
const keyvGet = vi.fn(() => 0)

const installFakeContainer = (result: { current: { containerRef: React.RefObject<HTMLDivElement | null> } }) => {
  const element = { scrollTop: 120, scrollTo: vi.fn() }
  ;(result.current.containerRef as { current: unknown }).current = element
  return element
}

beforeEach(() => {
  keyvSet.mockClear()
  keyvGet.mockClear()
  ;(window as unknown as { keyv: unknown }).keyv = { get: keyvGet, set: keyvSet, remove: vi.fn() }
  // rAF 同步执行：断言与帧时序无关（家规：不以计时作为回归信号）
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useScrollPosition r2-35：trailing 保存不被重渲染取消', () => {
  it('消费方连续重渲染后，trailing 仍以最终 scrollTop 落盘', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(() => useScrollPosition('chat', 100))
    const element = installFakeContainer(result)

    // leading 调用：立即保存当前位置
    act(() => result.current.handleScroll())
    expect(keyvSet).toHaveBeenLastCalledWith('scroll:chat', 120)

    keyvSet.mockClear()
    element.scrollTop = 250
    // 窗口内再次滚动 → 只登记 trailing，尚未落盘
    act(() => result.current.handleScroll())
    expect(keyvSet).not.toHaveBeenCalled()

    // 模拟流式期间消费方逐帧重渲染（旧实现在这里反复 cancel 掉 trailing）
    for (let i = 0; i < 5; i++) {
      act(() => rerender())
    }

    act(() => {
      vi.advanceTimersByTime(100)
    })

    // trailing 保存的是"停下来时"的位置
    expect(keyvSet).toHaveBeenCalledWith('scroll:chat', 250)
  })

  it('throttleWait 参数仍然决定 trailing 触发时刻', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useScrollPosition('chat', 100))
    const element = installFakeContainer(result)

    act(() => result.current.handleScroll())
    keyvSet.mockClear()

    element.scrollTop = 333
    act(() => result.current.handleScroll())

    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(keyvSet).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(60)
    })
    expect(keyvSet).toHaveBeenCalledWith('scroll:chat', 333)
  })
})
