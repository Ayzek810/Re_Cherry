import { act, renderHook } from '@testing-library/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DRAG_RESIZE_MAX_HEIGHT, useDragResizeHandle } from '../useDragResizeHandle'

const pressHandle = (clientY: number) => ({ clientY }) as unknown as ReactMouseEvent

describe('useDragResizeHandle', () => {
  it('tracks mousemove while holding the handle and stops on mouseup', () => {
    const onHeightChange = vi.fn()
    const { result } = renderHook(() =>
      useDragResizeHandle({ enabled: true, getStartHeight: () => 100, onHeightChange })
    )

    act(() => {
      result.current(pressHandle(100))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 80 }))
    })
    expect(onHeightChange).toHaveBeenLastCalledWith(120)

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 40 }))
    })
    // mouseup 之后不再有写入
    expect(onHeightChange).toHaveBeenCalledTimes(1)
  })

  it('clamps the height into the allowed range', () => {
    const onHeightChange = vi.fn()
    const { result } = renderHook(() =>
      useDragResizeHandle({ enabled: true, getStartHeight: () => 100, onHeightChange })
    )

    act(() => {
      result.current(pressHandle(0))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 5000 }))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: -5000 }))
    })

    expect(onHeightChange).toHaveBeenNthCalledWith(1, 40)
    expect(onHeightChange).toHaveBeenNthCalledWith(2, DRAG_RESIZE_MAX_HEIGHT)
  })

  it('removes the document listeners on unmount while the handle is still held', () => {
    const onHeightChange = vi.fn()
    const { result, unmount } = renderHook(() =>
      useDragResizeHandle({ enabled: true, getStartHeight: () => 100, onHeightChange })
    )

    act(() => {
      result.current(pressHandle(100))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 80 }))
    })
    expect(onHeightChange).toHaveBeenCalledTimes(1)

    // 按住把手不松手时卸载（切换助手/话题/路由）：旧实现只在 mouseup 里清理，
    // 监听会留在 document 上并对已卸载组件继续 onHeightChange
    unmount()
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 20 }))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(onHeightChange).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the handle is disabled', () => {
    const onHeightChange = vi.fn()
    const { result } = renderHook(() =>
      useDragResizeHandle({ enabled: false, getStartHeight: () => 100, onHeightChange })
    )

    act(() => {
      result.current(pressHandle(100))
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 20 }))
    })

    expect(onHeightChange).not.toHaveBeenCalled()
  })
})
