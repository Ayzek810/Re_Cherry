/**
 * 绘画图像服务（v0.3.3 批次6，V2 参数来源移植后的薄适配层）：AI 通路 = 轻量 AI
 * 服务面 lightGenerateImage/lightEditImage（LightLLM，OpenAI 兼容平面直连）——
 * 不自配 fetch 旁路（红线1）。错误归一为 PaintingGenerateError。
 *
 * fork 缝：参数不再具名收敛为 5 个扩展键（那正是"看得见却静默丢弃"的根源），
 * 而是把 canonical 参数袋 + 该模型声明的键整包上行，由主进程按 wire profile 改名。
 * "范围外 provider" 的明错在主进程抛出（`lightLlm: unsupported vendor`），此处
 * 翻译成 `UNSUPPORTED_VENDOR`，绝不静默。
 */
import type { PaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { createPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { lightEditImage, lightGenerateImage } from '@renderer/services/lightLlm'
import type { LightImageResult } from '@shared/lightLlm/types'
import { isUnsupportedVendorError } from '@shared/lightLlm/types'

export interface PaintingGenerateRequest {
  providerId: string
  modelId: string
  prompt: string
  /** canonical 参数袋（键 = 目录的 CanonicalParamKey：size/numImages/…）。 */
  paramValues: Record<string, unknown>
  /** 该模型声明的 canonical 键（= 目录 modes[mode].supports 的键面）。 */
  supportedParams: string[]
  requestId: string
}

export interface PaintingEditRequest {
  providerId: string
  modelId: string
  prompt: string
  /** 输入图（data URL）。 */
  inputImages: string[]
  paramValues: Record<string, unknown>
  supportedParams: string[]
  requestId: string
}

function toPaintingError(error: unknown): PaintingGenerateError {
  if (isUnsupportedVendorError(error)) {
    return createPaintingGenerateError('UNSUPPORTED_VENDOR')
  }
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
      // fork 缝：provider id 即 wire profile id（目录的 IMAGE_WIRE_PROFILES 同键）。
      wireProfileId: request.providerId,
      paramValues: request.paramValues,
      supportedParams: request.supportedParams,
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
      wireProfileId: request.providerId,
      paramValues: request.paramValues,
      supportedParams: request.supportedParams,
      requestId: request.requestId
    })
  } catch (error) {
    throw toPaintingError(error)
  }
}
