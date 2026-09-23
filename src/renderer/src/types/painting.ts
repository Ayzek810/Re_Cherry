/**
 * 绘画页类型（v0.3.3 批次4）：生成历史行（Dexie paintings 表）与生成参数。
 * 形状对齐 V2 PaintingSchema 收窄版；图片字节落 FileStorage（saveBase64Image），
 * 本表只存 FileMetadata 引用。
 */
import type { FileMetadata } from './index'

/** 绘画生成参数（表单态；提交时映射为 LightImageGenerateCall）。 */
export interface PaintingParams {
  prompt: string
  negativePrompt?: string
  imageSize: string
  batchSize: number
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
