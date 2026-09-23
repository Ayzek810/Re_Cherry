/**
 * 绘画生成管线（v0.3.3 批次4，② 薄适配）：createDefaultPainting 原样；V2 的
 * DataApi prefetch support/requirePrompt 段改为读本地 PAINTING_PARAM_TABLE
 * （表内有该键 = 支持；required 即 requirePrompt）；mode 推断原样（tabToImageGenerationMode）。
 */
import { loggerService } from '@logger'
import { PAINTING_PARAM_TABLE } from '@renderer/pages/paintings/form/paintingParamTable'
import { tabToImageGenerationMode } from '@renderer/pages/paintings/utils/paintingProviderMode'
import { uuid } from '@renderer/utils'
import type { LightImageResult } from '@shared/lightLlm/types'

import { canonicalGenerate } from './canonicalGenerate'
import type { GenerateInput } from './types/generateInput'
import type { PaintingData } from './types/paintingData'

const logger = loggerService.withContext('paintings/paintingPipeline')

export interface PaintingDraftDefaults {
  providerId: string
  modelId?: string
}

/**
 * Build an initial `PaintingData` row for a new painting under the given
 * provider and optional configured model. Every per-model knob lives in
 * `params: Record<string, unknown>` and gets populated by the form when the
 * user picks a model + edits controls.
 */
export function createDefaultPainting({ providerId, modelId }: PaintingDraftDefaults): PaintingData {
  return {
    id: uuid(),
    providerId,
    mode: 'generate',
    prompt: '',
    files: [],
    params: {},
    ...(modelId && { model: modelId })
  }
}

/**
 * Generic painting generate dispatch — the same flow for every provider:
 *
 *   1. Resolve requirePrompt from the local `PAINTING_PARAM_TABLE` (the table
 *      carries the key = the model supports it; `required` = prompt required).
 *   2. Hand off to `canonicalGenerate`, which filters/coerces `painting.params`
 *      against the table and ships a `PaintingGenerateRequest` through
 *      `paintingImageService` (lightGenerateImage/lightEditImage).
 */
export async function paintingGenerate(input: GenerateInput): Promise<LightImageResult> {
  const modelId = input.painting.model
  const canonicalMode = tabToImageGenerationMode(input.painting.mode)
  // fork 参数表全模型通用：prompt 必填即 requirePrompt；mode 原样透传。
  const requirePrompt = PAINTING_PARAM_TABLE.some((spec) => spec.key === 'prompt' && spec.required)
  const effectiveMode = canonicalMode ?? 'generate'

  if (modelId) {
    logger.debug('painting generate dispatch', { providerId: input.provider.id, modelId, effectiveMode })
  }

  return canonicalGenerate(input, { requirePrompt, mode: effectiveMode })
}
