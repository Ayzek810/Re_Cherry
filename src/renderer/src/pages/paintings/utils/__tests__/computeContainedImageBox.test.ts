/**
 * "完整展示"（contain）盒的不变量测试：算出来的盒子**永远**能放进容器、
 * 永远不放大超过原始尺寸，且按提示条占位扣减可用高度。
 * 这条不变量就是用户要的"图片被完整展示"——v0.3.3-9 之前它靠组件内联算术，
 * 高度算不出来时会退化成"上对齐填满 + 裁切"。
 */
import { computeContainedImageBox } from '@renderer/pages/paintings/utils/computeContainedImageBox'
import { describe, expect, it } from 'vitest'

const CONTAINER = { width: 1000, height: 600 }

/** 盒子的任一边都不得超出可用区域（含提示条占位）。 */
const expectFits = (box: { width: number; height: number } | null, reserved = 0) => {
  expect(box).not.toBeNull()
  expect(box!.width).toBeLessThanOrEqual(CONTAINER.width + 0.001)
  expect(box!.height).toBeLessThanOrEqual(CONTAINER.height - reserved + 0.001)
}

describe('computeContainedImageBox — 等比完整展示', () => {
  it('竖图：受高度限制，宽度按比例留出（不裁切、不拉宽）', () => {
    const box = computeContainedImageBox({ width: 1024, height: 1536 }, CONTAINER)
    expectFits(box)
    // height 用满 600，宽度按 2:3 比例 = 400 < 1000
    expect(box!.height).toBeCloseTo(600, 5)
    expect(box!.width).toBeCloseTo(400, 5)
    // 长宽比保持不变（这是"完整展示"的定义）
    expect(box!.width / box!.height).toBeCloseTo(1024 / 1536, 5)
  })

  it('横图：受高度限制，宽度按比例留出', () => {
    const box = computeContainedImageBox({ width: 1536, height: 1024 }, CONTAINER)
    expectFits(box)
    // 600/1024 = 0.586 比 1000/1536 = 0.651 更紧 → 高度用满 600，宽度 900
    expect(box!.height).toBeCloseTo(600, 5)
    expect(box!.width).toBeCloseTo(900, 5)
    expect(box!.width / box!.height).toBeCloseTo(1536 / 1024, 5)
  })

  it('小图不放大（scale 上限 1）', () => {
    expect(computeContainedImageBox({ width: 200, height: 100 }, CONTAINER)).toEqual({ width: 200, height: 100 })
  })

  it('提示条占位从可用高度里扣掉（否则图与提示条一起超出容器 → 被裁）', () => {
    const withBar = computeContainedImageBox({ width: 1024, height: 1536 }, CONTAINER, 200)
    expectFits(withBar, 200)
    expect(withBar!.height).toBeCloseTo(400, 5)
    expect(withBar!.width).toBeCloseTo(266.6667, 3)
  })

  it('尺寸未知 / 容器无效 → null（调用方走 CSS 兜底，绝不硬撑满）', () => {
    expect(computeContainedImageBox(null, CONTAINER)).toBeNull()
    expect(computeContainedImageBox({ width: 100, height: 100 }, null)).toBeNull()
    expect(computeContainedImageBox({ width: 0, height: 100 }, CONTAINER)).toBeNull()
    expect(computeContainedImageBox({ width: 100, height: 100 }, { width: 0, height: 600 })).toBeNull()
    // 提示条比容器还高 → 没有可用高度
    expect(computeContainedImageBox({ width: 100, height: 100 }, { width: 1000, height: 100 }, 150)).toBeNull()
  })
})
