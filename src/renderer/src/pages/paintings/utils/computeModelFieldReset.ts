/**
 * 表单字段重置补丁（v0.3.3 批次4，② 薄适配）：V2 computeModelFieldReset 主体
 * 保留——旧键清空/新默认播种/越界重置三段逻辑原样；数据源从 DataApi registry
 * support 换本地 PAINTING_PARAM_TABLE（imageGenerationToFields 的表驱动形态）。
 */
import { loggerService } from '@logger'
import type { BaseConfigItem } from '@renderer/pages/paintings/form/baseConfigItem'
import { imageGenerationToFields } from '@renderer/pages/paintings/form/imageGenerationToFields'

const logger = loggerService.withContext('paintings/modelFieldReset')

/**
 * Diff a painting's form-field state against the model it's about to use.
 * Returns a patch to merge into `painting.params` that:
 *   1. Nulls fields the old model wrote but the new model doesn't accept.
 *   2. Populates the new model's table-declared defaults (`initialValue`)
 *      for any field the user hasn't set yet.
 *   3. Resets carry-over values the new model can't accept: enum/select
 *      values absent from the new `options` list, and range/slider values
 *      outside the new `[min, max]` window.
 *
 * Apply alongside `{ model: newModelId }` in `usePaintingModelSwitch` so
 * post-switch state contains exactly the fields the new model accepts AND
 * the visible defaults match what the wire will actually receive.
 *
 * Returns `{}` when the new model has no table entry — no info, no patch.
 */
export async function computeModelFieldReset(input: {
  oldModelId: string | undefined
  newModelId: string
  mode: PaintingDataMode | undefined
  currentValues?: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const { oldModelId, newModelId, mode, currentValues = {} } = input
  if (oldModelId && oldModelId === newModelId) return {}

  // fork 缝：参数表全模型通用（无 per-model registry），old/new 字段面相同——
  // 只有 mode 变化会改变字段面。这里按 mode 派生一次。
  const newItems = imageGenerationToFields({ mode })
  if (newItems.length === 0) return {}

  const collectKeys = (items: BaseConfigItem[]): Set<string> => {
    const keys = new Set<string>()
    for (const item of items) {
      if (item.key) keys.add(item.key)
      // `customSize` widget aliases multiple persisted fields under one
      // BaseConfigItem. Collect each so the reset doesn't half-clear the trio.
      const widget = item as { widthKey?: string; heightKey?: string; sizeKey?: string }
      if (widget.widthKey) keys.add(widget.widthKey)
      if (widget.heightKey) keys.add(widget.heightKey)
      if (widget.sizeKey) keys.add(widget.sizeKey)
    }
    return keys
  }

  const newKeys = collectKeys(newItems)

  const patch: Record<string, unknown> = {}
  // 1. 旧键不在新字段面 → 清空（fork 表全模型通用，仅 customSize 伴随键可能残留）。
  for (const key of Object.keys(currentValues)) {
    if (!newKeys.has(key)) patch[key] = undefined
  }

  // 2/3. 新字段面：播种默认 + 越界重置。
  for (const item of newItems) {
    if (!item.key) continue
    if (Object.prototype.hasOwnProperty.call(patch, item.key)) continue

    const currentValue = currentValues[item.key]
    const isMissing = currentValue === undefined || currentValue === null || currentValue === ''

    // Field the user never set: seed the table default so the widget's visible
    // default matches the wire. Default-less field stays unset.
    if (isMissing) {
      if (item.initialValue !== undefined) patch[item.key] = item.initialValue
      continue
    }

    // Field carried a value over from the previous model. Validate it against
    // the new model's constraints; reset to the default (or `undefined`
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

type PaintingDataMode = 'generate' | 'edit'

// logger 保留给后续 per-model 表扩展（fork 当前无 per-model 差异）。
void logger
