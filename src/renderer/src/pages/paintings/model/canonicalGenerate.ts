/**
 * 通用绘画生成路径（v0.3.3 批次4，② 薄适配）：V2 canonicalGenerate 主体保留——
 * 输入图过滤/mode 推断/maxInputImages(本地常量 4)/prompt 必填/checkProviderEnabled/
 * customSize 合成/bytesToDataUrl。删：buildParamsSchema.safeParse →
 * 表驱动过滤（PAINTING_PARAM_TABLE + customSize 伴随键白名单）；出口从 generatePainting(主进程 IPC) 改为
 * paintingImageService.generatePaintingImages/editPaintingImages（PaintingGenerateRequest/
 * PaintingEditRequest 收敛）。
 */
import { loggerService } from '@logger'
import { createPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { PAINTING_PARAM_TABLE } from '@renderer/pages/paintings/form/paintingParamTable'
import { checkProviderEnabled } from '@renderer/pages/paintings/utils/checkProviderEnabled'
import FileManager from '@renderer/services/FileManager'
import { editPaintingImages, generatePaintingImages } from '@renderer/services/paintingImageService'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { LightImageResult } from '@shared/lightLlm/types'

import type { GenerateInput } from './types/generateInput'
import type { PaintingData } from './types/paintingData'

const logger = loggerService.withContext('paintings/canonicalGenerate')

/** fork 上限常量（V2 registry maxInputImages 的本地等价）。 */
// fork 缝（P0-A）：导出给作曲条物化闸复用，避免"4"出现第二个事实源。
export const MAX_INPUT_IMAGES = 4

/** Encode raw image bytes as a `data:` URL for the edit endpoint. */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mime || 'image/png'};base64,${btoa(binary)}`
}

export interface CanonicalGenerateOptions<T extends PaintingData> {
  /**
   * Throw a vendor-specific validation error before the generate call
   * fires. Use for cross-field rules that can't fit a single resolver.
   */
  preValidate?: (painting: T) => void
  /**
   * Whether `painting.prompt` must be non-empty. Default `true`. Pass
   * `false` (or a predicate returning `false`) for models that accept
   * empty prompts. `preValidate` is responsible for any per-model rule
   * when the standard check is skipped.
   */
  requirePrompt?: boolean | ((painting: T) => boolean)
  /** Resolved mode. Default `'generate'`. */
  mode?: PaintingData['mode']
}

/**
 * Generic painting generate path. Filters `painting.params` through the local
 * `PAINTING_PARAM_TABLE` (the fork's catalog equivalent), then ships a
 * `PaintingGenerateRequest`/`PaintingEditRequest` through
 * `paintingImageService` — the feature's single AI seam.
 *
 * Empty / undefined / empty-string entries are dropped so the server applies
 * its own default; no client-side defaults.
 */
export async function canonicalGenerate<T extends PaintingData>(
  input: GenerateInput<T>,
  options: CanonicalGenerateOptions<T> = {}
): Promise<LightImageResult> {
  const { painting, provider } = input

  // Vendor-specific cross-field errors first so they take precedence over
  // the generic MISSING_REQUIRED_FIELDS / PROMPT_REQUIRED throws below.
  options.preValidate?.(painting)

  // Only image files count as inputs — the composer can also carry non-image
  // attachments (e.g. a pasted-text `.txt`), which must never be treated/sent as an image.
  const inputImageFiles = (painting.inputFiles ?? []).filter(
    (entry) => (entry.type ?? FILE_TYPE.OTHER) === FILE_TYPE.IMAGE
  )
  const mode = options.mode ?? (inputImageFiles.length > 0 ? 'edit' : 'generate')
  if (inputImageFiles.length > MAX_INPUT_IMAGES) {
    throw createPaintingGenerateError('INPUT_IMAGE_LIMIT_EXCEEDED')
  }
  // Edit-only modes (anything but the text→image `generate` mode) can't run without an
  // input image. Enforce here — on the authoritative mode + the real input
  // files — so the model never receives invalid input, independent of transient UI state.
  if (mode !== 'generate' && inputImageFiles.length === 0) {
    throw createPaintingGenerateError('EDIT_IMAGE_REQUIRED')
  }

  await checkProviderEnabled(provider)
  const modelId = painting.model
  if (!modelId) throw createPaintingGenerateError('MISSING_REQUIRED_FIELDS')

  const prompt = (painting.prompt ?? '').trim()
  const promptRequired =
    typeof options.requirePrompt === 'function' ? options.requirePrompt(painting) : (options.requirePrompt ?? true)
  if (promptRequired && !prompt) throw createPaintingGenerateError('PROMPT_REQUIRED')

  // 1. Filter raw form params through the local param table (the fork's
  //    buildParamsSchema.safeParse equivalent): keep table keys plus the
  //    UI-only customSize companions (not table keys, but the custom-size
  //    composition below reads them from `source`).
  const companionKeys = new Set(['customSize_width', 'customSize_height'])
  const tableKeys = new Set(PAINTING_PARAM_TABLE.map((spec) => spec.key))
  const source = Object.fromEntries(
    Object.entries(painting.params ?? {}).filter(
      ([key]) => companionKeys.has(key) || tableKeys.has(key)
    )
  )

  // 2. Build the canonical `paramValues` bag: drop blanks (the byte-identical-wire
  //    invariant) and the UI-only `customSize_width`/`customSize_height` companions.
  const paramValues: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'customSize_width' || key === 'customSize_height') continue
    if (value === undefined || value === '' || value === null) continue
    paramValues[key] = value
  }

  // 3. Custom size: the customSize widget pairs `imageSize: 'custom'` with
  //    `customSize_width`/`customSize_height`. Compose them into `imageSize`;
  //    drop the sentinel when the pair is incomplete so the server applies
  //    its default.
  if (paramValues.imageSize === 'custom') {
    const width = source.customSize_width
    const height = source.customSize_height
    if (typeof width === 'number' && typeof height === 'number') {
      paramValues.imageSize = `${width}x${height}`
    } else {
      delete paramValues.imageSize
    }
  }

  // 4. Pre-fetch attached image bytes (encoded as `data:` URLs for the edit
  //    endpoint), carried separately from `paramValues` — they're encoded files,
  //    not form params. fork 缝：FileMetadata 经 FileManager.readBinaryImage 读字节。
  const inputImages =
    inputImageFiles.length > 0
      ? await Promise.all(
          inputImageFiles.map(async (entry: FileMetadata) => {
            const buffer = await FileManager.readBinaryImage(entry)
            return bytesToDataUrl(new Uint8Array(buffer), 'image/png')
          })
        )
      : undefined

  const requestId = painting.id
  const imageSize = (paramValues.imageSize as string | undefined) ?? '1024x1024'
  const batchSize = typeof paramValues.batchSize === 'number' ? paramValues.batchSize : 1

  // 出口收敛为 PaintingGenerateRequest/PaintingEditRequest（LightImageResult）；
  // FileMetadata[] 落盘由 runPainting.resolvePaintingFiles 承接。
  try {
    if (mode === 'edit' && inputImages && inputImages.length > 0) {
      return await editPaintingImages({
        providerId: provider.id,
        modelId,
        prompt,
        inputImages,
        imageSize,
        requestId
      })
    }
    return await generatePaintingImages({
      providerId: provider.id,
      modelId,
      prompt,
      imageSize,
      batchSize,
      ...(paramValues.negativePrompt !== undefined && { negativePrompt: paramValues.negativePrompt as string }),
      ...(paramValues.seed !== undefined && { seed: paramValues.seed as string }),
      ...(paramValues.numInferenceSteps !== undefined && {
        numInferenceSteps: paramValues.numInferenceSteps as number
      }),
      ...(paramValues.guidanceScale !== undefined && { guidanceScale: paramValues.guidanceScale as number }),
      ...(paramValues.quality !== undefined && { quality: paramValues.quality as string }),
      requestId
    })
  } catch (error) {
    logger.error('painting generate failed', { providerId: provider.id, modelId, mode, error })
    throw error
  }
}
