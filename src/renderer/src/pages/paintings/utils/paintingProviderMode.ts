import type { PaintingMode } from '@renderer/pages/paintings/model/types/paintingData'

/**
 * Bridge `PaintingMode` (the dbMode stored on PaintingData) to the canonical
 * mode used by `imageGenerationToFields(..., { mode })`. 'draw' aliases to
 * 'generate' for legacy PPIO paintings.
 *
 * fork 缝：PaintingMode 已收敛为 'generate' | 'edit'，V2 的 remix/upscale/merge
 * 返回分支随模式空间裁剪；入参放宽为 string 以保留 'draw' 遗留别名比较。
 */
export function tabToImageGenerationMode(dbMode: string): PaintingMode | undefined {
  if (dbMode === 'generate' || dbMode === 'draw') return 'generate'
  if (dbMode === 'edit') return 'edit'
  return undefined
}
