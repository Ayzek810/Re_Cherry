import { afterEach, describe, expect, it } from 'vitest'

import {
  abortPaintingGeneration,
  clearPaintingAbortController,
  getPaintingAbortController,
  registerPaintingAbortController
} from '../paintingAbortControllerStore'

// 模块级单例状态：清掉本文件碰过的 id，避免用例之间互相串味。
afterEach(() => {
  clearPaintingAbortController('p1')
  clearPaintingAbortController('p2')
})

describe('paintingAbortControllerStore', () => {
  // P0-E 回归：按 id 取消必须只掐对应画作——删除旧画 B 不得掐断正在生成的 A。
  it('abort 某个 paintingId 不触碰其他画作的控制器', () => {
    const generating = new AbortController()
    const other = new AbortController()
    registerPaintingAbortController('p1', generating)
    registerPaintingAbortController('p2', other)

    abortPaintingGeneration('p2')

    expect(other.signal.aborted).toBe(true)
    expect(generating.signal.aborted).toBe(false)
  })

  it('未登记的 id 是无害空操作；过期 controller 不驱逐在册的那一个', () => {
    const live = new AbortController()
    registerPaintingAbortController('p1', live)

    expect(() => abortPaintingGeneration('never-registered')).not.toThrow()

    clearPaintingAbortController('p1', new AbortController())
    expect(getPaintingAbortController('p1')).toBe(live)

    clearPaintingAbortController('p1', live)
    expect(getPaintingAbortController('p1')).toBeNull()
  })

  it('同一 id 再次登记会 abort 旧的 controller（单飞语义）', () => {
    const first = new AbortController()
    const second = new AbortController()
    registerPaintingAbortController('p1', first)
    registerPaintingAbortController('p1', second)

    expect(first.signal.aborted).toBe(true)
    expect(getPaintingAbortController('p1')).toBe(second)
  })
})
