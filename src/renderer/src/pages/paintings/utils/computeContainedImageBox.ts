/**
 * 画作展示区（Artboard）与生成骨架（PaintingImageSkeleton）共用的"等比完整显示"盒计算：
 * 给定图片自然尺寸与可用容器尺寸，返回**完整容纳**图片的盒子（contain，绝不超出容器、
 * 绝不放大超过原始尺寸）。V2 里这段算术内联在组件里（`Artboard.tsx` 的 `displayedImageBoxSize`
 * 与 `PaintingImageSkeleton` 的 lockedSize）；fork 抽成纯函数以便用测试钉住
 * "完整展示"这条不变量（v0.3.3-9：此前高度算不出来时退化成"上对齐填满 + 裁切"）。
 */

export interface Size {
  width: number
  height: number
}

/**
 * @param natural 图片自然尺寸（未知传 null）
 * @param container 可用区域尺寸（未测到传 null）
 * @param reservedHeight 同容器内其它已占用高度（如提示条），从可用高度里扣掉
 * @returns contain 盒；任一侧算不出有效值时返回 null（调用方据此走 CSS 兜底，而不是硬撑满）
 */
export function computeContainedImageBox(
  natural: Size | null,
  container: Size | null,
  reservedHeight = 0
): Size | null {
  if (!natural || !container) return null
  if (natural.width <= 0 || natural.height <= 0) return null
  if (container.width <= 0) return null
  const availableHeight = container.height - Math.max(0, reservedHeight)
  if (availableHeight <= 0) return null
  // 1 是上限：小图不放大（V2 同），等比缩到能完整放进容器
  const scale = Math.min(1, container.width / natural.width, availableHeight / natural.height)
  return { width: natural.width * scale, height: natural.height * scale }
}
