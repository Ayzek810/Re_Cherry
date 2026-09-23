/**
 * 绘画图像服务（v0.3.3 批次4，fork 侧新写薄适配层）：AI 通路 = 轻量 AI 服务面
 * lightGenerateImage/lightEditImage（批次1 端点，OpenAI 兼容平面直连）——
 * 不自配 fetch 旁路（红线1）。错误归一为 PaintingGenerateError（V2 shared 错误码）。
 */
import type { PaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { createPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { lightEditImage, lightGenerateImage } from '@renderer/services/lightLlm'
import type { LightImageResult } from '@shared/lightLlm/types'

export interface PaintingGenerateRequest {
  providerId: string
  modelId: string
  prompt: string
  imageSize: string
  batchSize: number
  negativePrompt?: string
  seed?: string
  numInferenceSteps?: number
  guidanceScale?: number
  quality?: string
  requestId: string
}

export interface PaintingEditRequest {
  providerId: string
  modelId: string
  prompt: string
  /** 输入图（data URL）。 */
  inputImages: string[]
  imageSize?: string
  requestId: string
}

function toPaintingError(error: unknown): PaintingGenerateError {
  if (error instanceof Error && error.message.includes('has no apiHost configured')) {
    return createPaintingGenerateError('PROVIDER_NOT_ENABLED')
  }
  return createPaintingGenerateError('GENERATION_FAILED', error instanceof Error ? error.message : String(error))
}

/** 文生图：经 lightGenerateImage 端点，返回 base64/url 图像列表。 */
export async function generatePaintingImages(request: PaintingGenerateRequest): Promise<LightImageResult> {
  try {
    return await lightGenerateImage({
      provider: request.providerId,
      model: request.modelId,
      prompt: request.prompt,
      imageSize: request.imageSize,
      batchSize: request.batchSize,
      negativePrompt: request.negativePrompt,
      seed: request.seed,
      numInferenceSteps: request.numInferenceSteps,
      guidanceScale: request.guidanceScale,
      quality: request.quality,
      requestId: request.requestId
    })
  } catch (error) {
    throw toPaintingError(error)
  }
}

/** 图生图（编辑）：经 lightEditImage 端点（逐张 multipart）。 */
export async function editPaintingImages(request: PaintingEditRequest): Promise<LightImageResult> {
  try {
    return await lightEditImage({
      provider: request.providerId,
      model: request.modelId,
      prompt: request.prompt,
      inputImages: request.inputImages,
      imageSize: request.imageSize,
      requestId: request.requestId
    })
  } catch (error) {
    throw toPaintingError(error)
  }
}
