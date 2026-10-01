// ported from https://github.com/ueberdosis/tiptap/blob/develop/packages/extension-drag-handle/src/helpers/findNextElementFromCursor.ts
import type { Editor } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'

export type FindElementNextToCoords = {
  x: number
  y: number
  direction?: 'left' | 'right'
  editor: Editor
}

/**
 * 指针向右游走的步数上限。
 * 原实现在「指针落在最后一块下方的空白区」时（`ProseMirror` 索引为 0、`slice(0,0)` 为空）
 * 会以 1px 步进逐次调用 `document.elementsFromPoint`，每次都强制样式/布局计算，直到窗口边缘。
 * 加上限把最坏情况变成有界开销。
 */
const MAX_PROBE_STEPS = 400

export const findElementNextToCoords = (options: FindElementNextToCoords) => {
  const { x, y, direction, editor } = options
  let resultElement: HTMLElement | null = null
  let resultNode: Node | null = null
  let pos: number | null = null

  let currentX = x
  let steps = 0

  while (resultNode === null && currentX < window.innerWidth && currentX > 0 && steps < MAX_PROBE_STEPS) {
    steps += 1
    const allElements = document.elementsFromPoint(currentX, y)
    const prosemirrorIndex = allElements.findIndex((element) => element.classList.contains('ProseMirror'))

    // 索引为 -1 表示指针已越过编辑器右缘。原实现 `slice(0, -1)` 会返回编辑器
    // **之外**的元素，随后 `posAtDOM(target, 0)` 抛 `RangeError: DOM position not inside the editor`，
    // 而这个异常是从 mousemove 处理器里抛出的。这里立即停止。
    if (prosemirrorIndex < 0) {
      break
    }

    const filteredElements = allElements.slice(0, prosemirrorIndex)
    const target = filteredElements[0]

    if (target instanceof HTMLElement && editor.view.dom.contains(target)) {
      resultElement = target
      pos = editor.view.posAtDOM(target, 0)

      if (pos >= 0) {
        resultNode = editor.state.doc.nodeAt(Math.max(pos - 1, 0))

        if (resultNode?.isText) {
          resultNode = editor.state.doc.nodeAt(Math.max(pos - 1, 0))
        }

        if (!resultNode) {
          resultNode = editor.state.doc.nodeAt(Math.max(pos, 0))
        }

        break
      }
    }

    if (direction === 'left') {
      currentX -= 1
    } else {
      currentX += 1
    }
  }

  return { resultElement, resultNode, pos: pos ?? null }
}
