/**
 * 指针越过编辑器右缘时不得抛 RangeError。
 *
 * 原状：`elementsFromPoint` 里找不到 `.ProseMirror` 时索引为 -1，`slice(0, -1)` 会返回编辑器
 * **之外**的元素，随后 `view.posAtDOM(target, 0)` 抛
 * `RangeError: DOM position not inside the editor`，而这个异常是从 mousemove 处理器里抛出的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { findElementNextToCoords } from '../helpers/findNextElementFromCursor'

const stubElementsFromPoint = (elements: Element[]) => {
  const fn = vi.fn(() => elements)
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, writable: true, value: fn })
  return fn
}

afterEach(() => {
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint
})

const createEditor = (insideElement: HTMLElement | null) => ({
  view: {
    dom: {
      contains: (node: Node) => node === insideElement
    },
    posAtDOM: vi.fn(() => {
      throw new RangeError('DOM position not inside the editor')
    })
  },
  state: { doc: { nodeAt: vi.fn(() => null) } }
})

describe('findElementNextToCoords boundary guard', () => {
  it('stops probing and returns no match when the pointer is beyond the editor', () => {
    const outside = document.createElement('div')
    document.body.appendChild(outside)

    // 指针已越过编辑器右缘：elementsFromPoint 里没有 .ProseMirror。
    const elementsFromPoint = stubElementsFromPoint([outside])
    const editor = createEditor(null)

    let result: ReturnType<typeof findElementNextToCoords> | undefined
    expect(() => {
      result = findElementNextToCoords({ editor: editor as never, x: 500, y: 200, direction: 'right' })
    }).not.toThrow()

    expect(result?.resultNode).toBeNull()
    expect(result?.pos).toBeNull()
    // 越界即停，不再按 1px 步进游走到窗口边缘。
    expect(elementsFromPoint).toHaveBeenCalledTimes(1)

    outside.remove()
  })

  it('never calls posAtDOM with an element outside the editor', () => {
    const outsideChild = document.createElement('span')
    const prosemirror = document.createElement('div')
    prosemirror.className = 'ProseMirror'

    stubElementsFromPoint([outsideChild, prosemirror])
    const editor = createEditor(null)

    const result = findElementNextToCoords({ editor: editor as never, x: 100, y: 100, direction: 'right' })

    expect(editor.view.posAtDOM).not.toHaveBeenCalled()
    expect(result.resultNode).toBeNull()
  })
})
