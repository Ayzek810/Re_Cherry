import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef } from 'react'

/** 拉伸把手的上下限（原实现写在 InputbarCore 的 handleDragStart 里）。 */
export const DRAG_RESIZE_MIN_HEIGHT = 40
export const DRAG_RESIZE_MAX_HEIGHT = 500

interface UseDragResizeHandleOptions {
  /** 与 `InputbarConfig.enableDragDrop` 同形（该字段是可选的 false 语义）。 */
  enabled?: boolean
  getStartHeight: () => number
  onHeightChange: (height: number) => void
}

/**
 * 拉伸把手的全局 mousemove/mouseup 监听（f2-12）。
 *
 * 旧实现在 InputbarCore 内联创建这两个监听，且只在 `mouseup` 里清理：按住把手不松手时切换助手/话题
 * 或路由卸载 Inputbar，`mouseup` 不再落回原处理链 → 监听永久留在 `document` 上，并在每次鼠标移动时
 * 对已卸载组件调用 `onHeightChange`（向 InputbarInner 的 setCustomHeight 写状态）。
 * 这里把监听收口到一处：重复按下先清上一对，卸载时统一移除。
 */
export const useDragResizeHandle = ({ enabled, getStartHeight, onHeightChange }: UseDragResizeHandleOptions) => {
  const startDragYRef = useRef(0)
  const startHeightRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
    }
  }, [])

  return useCallback(
    (event: ReactMouseEvent) => {
      if (!enabled) {
        return
      }

      startDragYRef.current = event.clientY
      startHeightRef.current = getStartHeight()

      function cleanup() {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        if (cleanupRef.current === cleanup) cleanupRef.current = null
      }

      function handleMouseMove(moveEvent: MouseEvent) {
        const deltaY = startDragYRef.current - moveEvent.clientY
        onHeightChange(
          Math.max(DRAG_RESIZE_MIN_HEIGHT, Math.min(DRAG_RESIZE_MAX_HEIGHT, startHeightRef.current + deltaY))
        )
      }

      function handleMouseUp() {
        cleanup()
      }

      cleanupRef.current?.()
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      cleanupRef.current = cleanup
    },
    [enabled, getStartHeight, onHeightChange]
  )
}
