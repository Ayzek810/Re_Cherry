/**
 * 标签页右键菜单的能力判定契约（V2 `getTabCapabilities` 的 fork 子集）。
 * 关键行为：**批量关闭只作用于普通区** —— 固定标签页发起时只要还有普通标签页就能用，
 * 普通标签页发起时需要至少还有一个同级普通标签页；`home` 不可关闭。
 */
import { describe, expect, it } from 'vitest'

import { getTabCapabilities } from '../tabCapabilities'

describe('getTabCapabilities', () => {
  it('固定标签页：可取消固定、可关闭，且对"关闭其他"豁免（只看普通区）', () => {
    expect(getTabCapabilities({ id: 'a', isPinned: true }, { pinnedCount: 1, normalCount: 0 })).toEqual({
      togglePin: true,
      close: true,
      closeOthers: false
    })
    expect(getTabCapabilities({ id: 'a', isPinned: true }, { pinnedCount: 2, normalCount: 3 }).closeOthers).toBe(true)
  })

  it('普通标签页：需要至少还有一个同级普通标签页才能"关闭其他"', () => {
    expect(getTabCapabilities({ id: 'a' }, { pinnedCount: 0, normalCount: 1 }).closeOthers).toBe(false)
    expect(getTabCapabilities({ id: 'a' }, { pinnedCount: 0, normalCount: 2 }).closeOthers).toBe(true)
    // 固定区有多少个都不影响普通标签页的判定
    expect(getTabCapabilities({ id: 'a' }, { pinnedCount: 5, normalCount: 1 }).closeOthers).toBe(false)
  })

  it('home 不可关闭', () => {
    expect(getTabCapabilities({ id: 'home' }, { pinnedCount: 0, normalCount: 2 }).close).toBe(false)
    expect(getTabCapabilities({ id: 'settings' }, { pinnedCount: 0, normalCount: 2 }).close).toBe(true)
  })
})
