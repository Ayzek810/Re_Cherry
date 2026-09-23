/**
 * 绘画生成管线（v0.3.3 批次6，V2 移植）：createDefaultPainting 原样；V2 的
 * DataApi prefetch `image-generation-support` 段改为读
 * `@shared/lightLlm/imageGenerationCatalog` 的静态目录（同序：provider override
 * → creator 默认），`requirePrompt` / `effectiveMode` / `support` 三者的推导与
 * V2 逐行同构。
 */
import { loggerService } from '@logger'
import { tabToImageGenerationMode } from '@renderer/pages/paintings/utils/paintingProviderMode'
import { uuid } from '@renderer/utils'
import type { ImageGenerationMode, ImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
import { getImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
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
 *   1. Resolve the model's `imageGeneration` block (support + effective mode +
 *      `requirePrompt`) from the fork catalog.
 *   2. Hand off to `canonicalGenerate`, which validates/coerces `painting.params`
 *      against that support + the shared catalog.
 *
 * Only the text→image `generate` tab is exposed by the fork page, so `mode` is the
 * tab-derived canonical mode; `effectiveMode` falls back to the model's first
 * declared mode exactly as V2 does.
 */
export async function paintingGenerate(input: GenerateInput): Promise<LightImageResult> {
  const modelId = input.painting.model
  const canonicalMode = tabToImageGenerationMode(input.painting.mode)
  let requirePrompt: boolean | undefined
  // Threaded into canonicalGenerate so it can validate/coerce params against
  // the model's support + shared catalog.
  let support: ImageGenerationSupport | undefined
  let effectiveMode: ImageGenerationMode | undefined

  if (modelId) {
    // fork 缝：V2 在此 try/catch 包 DataApi prefetch；fork 的目录是同步静态数据，
    // 无失败面（取不到 = 该模型不在这条平面上，support 为 undefined）。
    support = getImageGenerationSupport(input.provider.id, modelId) ?? undefined
    const modes = support?.modes
    effectiveMode =
      canonicalMode && modes?.[canonicalMode]
        ? canonicalMode
        : modes
          ? (Object.keys(modes)[0] as ImageGenerationMode)
          : undefined
    requirePrompt = effectiveMode && modes ? modes[effectiveMode]?.requirePrompt : undefined
  }

  const options = {
    ...(requirePrompt !== undefined && { requirePrompt }),
    ...(support !== undefined && { support }),
    ...(effectiveMode !== undefined && { mode: effectiveMode })
  }
  if (modelId) {
    logger.debug('painting generate dispatch', {
      providerId: input.provider.id,
      modelId,
      mode: effectiveMode,
      supported: support !== undefined
    })
  }
  return canonicalGenerate(input, options)
}
