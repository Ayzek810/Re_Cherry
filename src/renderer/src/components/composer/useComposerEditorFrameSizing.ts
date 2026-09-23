// fork 缝：V2 `components/composer/useComposerEditorFrameSizing.ts` 的非 compact 子集。
// 抄自 V2:13-16 的 class 常量与 V2:79-107 `getComposerEditorContentStyle` 的 CSS 变量；
// 高度动画/`useResizeDrag`（fork 无该 hook）换成等价的内联拖拽 + 键盘步进。
import type { CSSProperties } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { getComposerEditorMinHeight } from './composerSizing'

/** V2 useComposerEditorFrameSizing.ts:13-16，逐字。 */
export const COMPOSER_EDITOR_COLLAPSED_MAX_HEIGHT = 'max(220px, 40vh)'
export const COMPOSER_EDITOR_EXPANDED_MAX_HEIGHT = 'max(220px, 50vh)'
export const COMPOSER_EDITOR_COLLAPSED_MAX_HEIGHT_CLASS = 'max-h-[max(220px,40vh)]!'
export const COMPOSER_EDITOR_EXPANDED_MAX_HEIGHT_CLASS = 'max-h-[max(220px,50vh)]!'

const COMPOSER_EDITOR_HEIGHT_TRANSITION_MS = 260
const COMPOSER_EDITOR_RESIZE_KEYBOARD_STEP = 16

type ComposerEditorContentStyle = CSSProperties & {
  '--composer-editor-padding': string
  '--composer-editor-min-height': string
  '--composer-editor-font-size': string
  '--composer-editor-line-height': string
  '--composer-editor-max-height': string
  '--composer-editor-overflow-y': 'auto' | 'hidden'
  '--composer-editor-height': 'auto' | '100%'
}

/** V2 useComposerEditorFrameSizing.ts:79-107 `getComposerEditorContentStyle`（非 compact 分支）。 */
export function getComposerEditorContentStyle(
  fontSize: number,
  isExpanded: boolean,
  manualEditorFrameHeight: number | null
): ComposerEditorContentStyle {
  const minHeight = getComposerEditorMinHeight(fontSize)
  const hasCustomHeight = isExpanded || manualEditorFrameHeight !== null
  const isFixedHeight = hasCustomHeight
  const maxHeight = isExpanded
    ? COMPOSER_EDITOR_EXPANDED_MAX_HEIGHT
    : manualEditorFrameHeight !== null
      ? `${manualEditorFrameHeight}px`
      : COMPOSER_EDITOR_COLLAPSED_MAX_HEIGHT

  return {
    height: hasCustomHeight ? '100%' : undefined,
    minHeight,
    '--composer-editor-padding': '6px 44px 0 15px',
    '--composer-editor-min-height': `${minHeight}px`,
    '--composer-editor-font-size': `${fontSize}px`,
    '--composer-editor-line-height': '1.4',
    '--composer-editor-max-height': maxHeight,
    '--composer-editor-overflow-y': 'auto',
    '--composer-editor-height': isFixedHeight ? '100%' : 'auto'
  }
}

function getViewportRelativeHeightPx(minHeight: number, viewportRatio: number) {
  return Math.max(minHeight, Math.round(window.innerHeight * viewportRatio))
}

function getExpandedEditorFrameHeightPx(editorMinHeight: number) {
  return Math.max(editorMinHeight, getViewportRelativeHeightPx(220, 0.5))
}

interface ComposerEditorFrameSizingOptions {
  fontSize: number
  isExpanded: boolean
  onExpandedChange: (expanded: boolean) => void
}

/**
 * V2 `useComposerEditorFrameSizing` 的非 compact 子集：折叠/展开/手动拖高三种高度，
 * 以及交给 textarea 的 `editorContentStyle`。fork 缝：省略 V2 的 260ms 高度动画
 * （V2:135-144/240-255 的过渡帧）与 `useResizeDrag`，拖拽直接改高度。
 */
export function useComposerEditorFrameSizing({
  fontSize,
  isExpanded,
  onExpandedChange
}: ComposerEditorFrameSizingOptions) {
  const minHeight = getComposerEditorMinHeight(fontSize)
  const maxHeight = getExpandedEditorFrameHeightPx(minHeight)
  const frameRef = useRef<HTMLDivElement>(null)
  const [manualHeight, setManualHeight] = useState<number | null>(null)
  const dragStateRef = useRef<{ startClientY: number; startHeight: number; collapseExpanded: boolean } | null>(null)

  const hasCustomHeight = isExpanded || manualHeight !== null
  const resizeHandleValue = isExpanded ? maxHeight : (manualHeight ?? minHeight)

  const clampHeight = useCallback(
    (height: number) => Math.min(maxHeight, Math.max(minHeight, Math.round(height))),
    [maxHeight, minHeight]
  )

  const getCurrentHeight = useCallback(() => {
    const measured = frameRef.current?.offsetHeight
    if (measured) return measured
    if (isExpanded) return maxHeight
    return manualHeight ?? minHeight
  }, [isExpanded, manualHeight, maxHeight, minHeight])

  // fork 缝：V2 走 `useResizeDrag`（全局 mousemove/mouseup 订阅），这里用一次性
  // window 监听达到同一手势。
  const handleResizeMove = useCallback(
    (event: MouseEvent) => {
      const drag = dragStateRef.current
      if (!drag) return
      if (drag.collapseExpanded) {
        drag.collapseExpanded = false
        onExpandedChange(false)
      }
      setManualHeight(clampHeight(drag.startHeight + drag.startClientY - event.clientY))
    },
    [clampHeight, onExpandedChange]
  )

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      dragStateRef.current = {
        startClientY: event.clientY,
        startHeight: getCurrentHeight(),
        collapseExpanded: isExpanded
      }
      const handleUp = () => {
        dragStateRef.current = null
        window.removeEventListener('mousemove', handleResizeMove)
        window.removeEventListener('mouseup', handleUp)
      }
      window.addEventListener('mousemove', handleResizeMove)
      window.addEventListener('mouseup', handleUp)
    },
    [getCurrentHeight, handleResizeMove, isExpanded]
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const currentHeight = getCurrentHeight()
      let nextHeight: number | null = null
      switch (event.key) {
        case 'ArrowUp':
          nextHeight = currentHeight + COMPOSER_EDITOR_RESIZE_KEYBOARD_STEP
          break
        case 'ArrowDown':
          nextHeight = currentHeight - COMPOSER_EDITOR_RESIZE_KEYBOARD_STEP
          break
        case 'Home':
          nextHeight = minHeight
          break
        case 'End':
          nextHeight = maxHeight
          break
      }
      if (nextHeight === null) return
      event.preventDefault()
      if (isExpanded) onExpandedChange(false)
      setManualHeight(clampHeight(nextHeight))
    },
    [clampHeight, getCurrentHeight, isExpanded, maxHeight, minHeight, onExpandedChange]
  )

  const toggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !isExpanded
      if (!target) setManualHeight(null)
      onExpandedChange(target)
    },
    [isExpanded, onExpandedChange]
  )

  const restoreDefaultHeight = useCallback(() => {
    setManualHeight(null)
    onExpandedChange(false)
  }, [onExpandedChange])

  const frameStyle = useMemo<CSSProperties>(
    () => ({
      height: isExpanded ? COMPOSER_EDITOR_EXPANDED_MAX_HEIGHT : manualHeight !== null ? `${manualHeight}px` : undefined,
      minHeight,
      overflow: 'hidden',
      transitionDuration: `${COMPOSER_EDITOR_HEIGHT_TRANSITION_MS}ms`
    }),
    [isExpanded, manualHeight, minHeight]
  )

  const editorContentStyle = useMemo(
    () => getComposerEditorContentStyle(fontSize, isExpanded, manualHeight),
    [fontSize, isExpanded, manualHeight]
  )

  return {
    frameRef,
    frameStyle,
    editorContentStyle,
    minHeight,
    maxHeight,
    resizeHandleValue,
    hasCustomHeight,
    startResize,
    handleResizeKeyDown,
    toggleExpanded,
    restoreDefaultHeight
  }
}
