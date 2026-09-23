/**
 * 绘画页类型（v0.3.3 批次4）：生成历史行（Dexie paintings 表）与生成参数。
 * 形状对齐 V2 PaintingSchema 收窄版；图片字节落 FileStorage（saveBase64Image），
 * 本表只存 FileMetadata 引用。
 */
import type { FileMetadata } from './index'

/**
 * 绘画生成参数（表单态；提交时映射为 `LightImageGenerateCall`）。
 *
 * v0.3.3 批次6：键名统一到 V2 canonical（`size`/`numImages`）。旧行里的
 * `imageSize`/`batchSize` 由 `canonicalGenerate.withLegacyAliases` 读时兼容，
 * 故两者在此仍标为可选（不删字段——Dexie 里真有带旧键的历史行）。
 */
export interface PaintingParams {
  prompt: string
  negativePrompt?: string
  size?: string
  numImages?: number
  /** @deprecated v0.3.3 批次6 前的旧键；读时经 withLegacyAliases 映射为 `size`。 */
  imageSize?: string
  /** @deprecated v0.3.3 批次6 前的旧键；读时经 withLegacyAliases 映射为 `numImages`。 */
  batchSize?: number
  seed?: string
  numInferenceSteps?: number
  guidanceScale?: number
}

/** 绘画历史记录（Dexie paintings 表行；v16 起用）。 */
export interface PaintingRecord {
  id: string
  providerId: string
  modelId: string
  prompt: string
  params: PaintingParams
  /** 生成输出（FileMetadata 引用；字节在 FileStorage）。 */
  output: FileMetadata[]
  /** 编辑输入（图生图时的源图引用）。 */
  input: FileMetadata[]
  createdAt: number
  updatedAt: number
}
