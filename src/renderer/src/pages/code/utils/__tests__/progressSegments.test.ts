/**
 * 进度条分段算术契约。
 *
 * 真机判据（用户反馈）：hermes 与 paper-agent 的进度条"不正常工作"——安装的大部分时长在
 * pip/npm/vite 这类**没有诚实百分比**的执行阶段，单条进度条只能装死。分段的骨架是"已完成
 * n 段"这个事实，这段算术一旦错（0 起 vs 1 起、越界、整体百分比），出错方式全是"看起来在动"。
 */
import { describe, expect, it } from 'vitest'

import { clampStage, overallPercent, segmentFills } from '../progressSegments'

describe('clampStage', () => {
  it('keeps a real position as given', () => {
    expect(clampStage({ index: 3, total: 6 })).toEqual({ index: 3, total: 6 })
  })

  it('clamps an out-of-range payload instead of drawing a broken bar', () => {
    expect(clampStage({ index: 9, total: 6 })).toEqual({ index: 6, total: 6 })
    expect(clampStage({ index: 0, total: 6 })).toEqual({ index: 1, total: 6 })
    expect(clampStage({ index: -2, total: 6 })).toEqual({ index: 1, total: 6 })
    expect(clampStage({ index: 1, total: 0 })).toEqual({ index: 1, total: 1 })
  })

  it('treats a missing stage as a single segment', () => {
    expect(clampStage(undefined)).toEqual({ index: 1, total: 1 })
  })
})

describe('segmentFills', () => {
  it('fills completed segments, fills the current one by measure, leaves the rest empty', () => {
    expect(segmentFills({ index: 3, total: 5 }, 40)).toEqual([100, 100, 40, 0, 0])
  })

  it('marks the current segment indeterminate (null) when nothing is measurable', () => {
    // pip/npm/vite 的执行阶段就是这一行：段往前走了（事实），但段内不编比例——
    // 渲染层据此画脉冲，而不是画一个假的 40%。
    expect(segmentFills({ index: 4, total: 4 }, null)).toEqual([100, 100, 100, null])
  })

  it('is a single indeterminate track when no stage is known', () => {
    expect(segmentFills(undefined, null)).toEqual([null])
    expect(segmentFills(undefined, 63)).toEqual([63])
  })
})

describe('overallPercent', () => {
  it('counts finished segments plus the measurable part of the current one', () => {
    expect(overallPercent({ index: 3, total: 5 }, 40)).toBe(48)
  })

  it('treats an unmeasurable current segment as "at least this far"', () => {
    expect(overallPercent({ index: 4, total: 4 }, null)).toBe(75)
  })

  it('stays deterministic without a stage, and indeterminate without a measure', () => {
    expect(overallPercent(undefined, 63)).toBe(63)
    expect(overallPercent(undefined, null)).toBeNull()
  })
})
