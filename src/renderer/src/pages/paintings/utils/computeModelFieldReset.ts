/**
 * 表单字段重置补丁（v0.3.3 批次6，V2 移植）：V2
 * `src/renderer/pages/paintings/utils/computeModelFieldReset.ts` 主体照抄——
 * 旧键清空 / 新默认播种 / 越界重置三段逻辑逐行相同。
 *
 * fork 缝：V2 的 support 经 DataApi prefetch（old/new 各一次），fork 改为从
 * `@shared/lightLlm/imageGenerationCatalog` 按 (providerId, modelId) 同步解析，
 * 解析序（provider override → creator 默认）与 V2 `getImageGenerationSupport` 同。
 */
import { loggerService } from '@logger'
import type { BaseConfigItem } from '@renderer/pages/paintings/form/baseConfigItem'
import { imageGenerationToFields } from '@renderer/pages/paintings/form/imageGenerationToFields'
import type { ImageGenerationMode, ImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
import { getImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'

const logger = loggerService.withContext('paintings/modelFieldReset')

/**
 * Diff a painting's form-field state against the model it's about to use.
 * Returns a patch to merge into `painting.params` that:
 *   1. Nulls fields the old model wrote but the new model doesn't accept
 *      (otherwise stale `aspectRatio` / `styleType` / etc. would leak to the
 *      wire on a model that rejects them).
 *   2. Populates the new model's declared defaults (`spec.default`) for any
 *      field the user hasn't set yet — without this, widgets display a default
 *      visually via `item.initialValue` but never commit it to state, so
 *      `canonicalGenerate` reads `undefined` and the transport omits the field.
 *   3. Resets carry-over values the new model can't accept: enum/select values
 *      absent from the new `options` list, and range/slider values outside the
 *      new `[min, max]` window.
 *
 * Apply alongside `{ model: newModelId }` in `usePaintingModelSwitch` so
 * post-switch state contains exactly the fields the new model accepts AND
 * the visible defaults match what the wire will actually receive.
 *
 * Returns `{}` when the new model has no catalog block (custom or user-named
 * models without an `imageGeneration` entry) — no info, no patch.
 */
export async function computeModelFieldReset(input: {
  providerId: string
  oldModelId: string | undefined
  newModelId: string
  mode: ImageGenerationMode | undefined
  currentValues?: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const { providerId, oldModelId, newModelId, mode, currentValues = {} } = input
  if (oldModelId && oldModelId === newModelId) return {}

  // fork 缝：V2 在此 await prefetch（可失败 → undefined）；fork 目录同步，
  // 取不到即 undefined（该模型不在这条平面上）。
  const fetchSupport = (modelId: string): ImageGenerationSupport | undefined => {
    try {
      return getImageGenerationSupport(providerId, modelId) ?? undefined
    } catch (error) {
      logger.warn('Failed to resolve image-generation-support', { providerId, modelId, error })
      return undefined
    }
  }

  const oldSupport = oldModelId ? fetchSupport(oldModelId) : undefined
  const newSupport = fetchSupport(newModelId)

  const oldItems = oldSupport ? imageGenerationToFields(oldSupport, { mode }) : []
  const newItems = newSupport ? imageGenerationToFields(newSupport, { mode }) : []
  if (newItems.length === 0) return {}

  const collectKeys = (items: BaseConfigItem[]): Set<string> => {
    const keys = new Set<string>()
    for (const item of items) {
      if (item.key) keys.add(item.key)
      // `customSize` widget aliases multiple persisted fields under one
      // BaseConfigItem (zhipu cogview). Collect each so the reset doesn't
      // half-clear the trio.
      const widget = item as { widthKey?: string; heightKey?: string; sizeKey?: string }
      if (widget.widthKey) keys.add(widget.widthKey)
      if (widget.heightKey) keys.add(widget.heightKey)
      if (widget.sizeKey) keys.add(widget.sizeKey)
    }
    return keys
  }

  const oldKeys = collectKeys(oldItems)
  const newKeys = collectKeys(newItems)

  const patch: Record<string, unknown> = {}
  for (const key of oldKeys) {
    if (!newKeys.has(key)) patch[key] = undefined
  }

  for (const item of newItems) {
    if (!item.key) continue
    if (Object.prototype.hasOwnProperty.call(patch, item.key)) continue

    const currentValue = currentValues[item.key]
    const isMissing = currentValue === undefined || currentValue === null || currentValue === ''

    // Field the user never set: seed the new model's declared default so the
    // widget's visible default matches the wire. Default-less field stays unset.
    if (isMissing) {
      if (item.initialValue !== undefined) patch[item.key] = item.initialValue
      continue
    }

    // Field carried a value over from the previous model. Validate it against
    // the new model's constraints; reset to the new default (or `undefined`
    // when there's none) whenever it no longer fits.
    const options = typeof item.options === 'function' ? item.options(item, currentValues) : (item.options ?? [])
    if (options.length > 0) {
      const allowedValues = new Set(options.map((option) => String(option.value)))
      if (!allowedValues.has(String(currentValue))) patch[item.key] = item.initialValue
      continue
    }

    if (item.type === 'slider') {
      const numeric = typeof currentValue === 'number' ? currentValue : Number(currentValue)
      const outOfRange =
        Number.isNaN(numeric) ||
        (typeof item.min === 'number' && numeric < item.min) ||
        (typeof item.max === 'number' && numeric > item.max)
      if (outOfRange) patch[item.key] = item.initialValue
    }
  }

  return patch
}
