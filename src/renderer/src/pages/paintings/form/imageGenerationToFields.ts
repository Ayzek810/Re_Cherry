/**
 * 参数表 → 表单字段派发器（v0.3.3 批次4，② 薄适配）：specToField switch 骨架 +
 * OPTION_LABELS 机制保留；44 键 KEY_LABELS 穷举 → 以 PAINTING_PARAM_TABLE 键穷举
 * （`as const` 保 TS 检查——表加键不加标签即编译错）；校验不走 buildParamsSchema
 * （fork 轻校验在 canonicalGenerate）。
 */
import type { BaseConfigItem, OptionItem } from './baseConfigItem'
import type { PaintingParamSpec } from './paintingParamTable'
import { PAINTING_PARAM_TABLE } from './paintingParamTable'

/**
 * Param-table key → i18n labels. Exhaustive over the `PAINTING_PARAM_TABLE`
 * keys: every table key MUST have a label, so adding a key to the table
 * without a label here is a compile error (rather than a silent raw-key
 * render). Adding a new canonical control is a one-row addition to the table
 * + a label row here — no schema change, no per-key handler.
 */
const KEY_LABELS = {
  prompt: { title: 'paintings.param.prompt' },
  imageSize: { title: 'paintings.param.size' },
  batchSize: { title: 'paintings.param.batch_size' },
  negativePrompt: { title: 'paintings.param.negative_prompt' },
  seed: { title: 'paintings.param.seed' },
  numInferenceSteps: { title: 'paintings.param.num_inference_steps' },
  guidanceScale: { title: 'paintings.param.guidance_scale' },
  quality: { title: 'paintings.param.quality' }
} as const satisfies Record<(typeof PAINTING_PARAM_TABLE)[number]['key'], { title: string; tooltip?: string }>

/**
 * Param-table key → per-option-value i18n label key. The parallel of
 * `KEY_LABELS`, but for the *options* of enum/chip controls. Values not listed
 * here fall back to the raw option value — correct for literal enums
 * (`imageSize`, `quality`) whose options are already human-readable, apart
 * from their shared `auto` value (below), which localizes so chips and the
 * artboard prompt bar read e.g. `自动` instead of the raw enum.
 */
const SIZE_AUTO_OPTION = { auto: 'paintings.image_size_options.auto' }
const OPTION_LABELS: Partial<Record<keyof typeof KEY_LABELS, Record<string, string>>> = {
  imageSize: SIZE_AUTO_OPTION,
  quality: {
    auto: 'paintings.quality_options.auto',
    low: 'paintings.quality_options.low',
    medium: 'paintings.quality_options.medium',
    high: 'paintings.quality_options.high',
    standard: 'paintings.quality_options.standard',
    hd: 'paintings.quality_options.hd'
  }
}

function toOptions(key: string, values: readonly string[]): OptionItem[] {
  // `key` is a runtime string from the param table; index defensively
  // (the typed maps are keyed by table key, the cast just bridges the
  // string→literal index).
  const labelMap = (OPTION_LABELS as Record<string, Record<string, string>>)[key]
  return values.map((v) => {
    const labelKey = labelMap?.[v]
    return labelKey ? { labelKey, value: v } : { label: v, value: v }
  })
}

function specToField(
  key: string,
  spec: PaintingParamSpec,
  allSpecs: Record<string, PaintingParamSpec>,
  items: BaseConfigItem[]
): BaseConfigItem | null {
  const labels = (KEY_LABELS as Record<string, { title: string; tooltip?: string }>)[key] ?? { title: key }
  switch (spec.kind) {
    case 'textarea':
      return { type: 'textarea', key, ...labels }
    case 'text':
      return { type: 'input', key, ...labels }
    case 'number':
    case 'slider': {
      const item: BaseConfigItem = {
        type: 'slider',
        key,
        ...labels,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        initialValue: spec.min
      }
      return item
    }
    case 'size': {
      // A sibling size-type spec lets the user pick arbitrary width × height.
      // Append the `'custom'` chip to the size enum — the same key the custom
      // size arm reads.
      const options: OptionItem[] = toOptions(key, spec.sizes ?? [])
      const customOption = { labelKey: 'paintings.custom_size', value: 'custom' }
      const customIndex = options.findIndex((option) => option.value === 'custom')
      if (customIndex >= 0) options[customIndex] = customOption
      else options.push(customOption)
      items.push({
        type: 'sizeChips',
        key,
        ...labels,
        options,
        initialValue: spec.sizes?.[0],
        columns: 3,
        sizeKey: allSpecs[key]?.key ?? key
      })
      // V2 companion widget: renders the width×height inputs only while the
      // parent chip holds `'custom'`, persisting under the canonical
      // `customSize_width`/`customSize_height` names that `canonicalGenerate`
      // composes and `paintingSize` previews read.
      items.push({
        type: 'customSize',
        key: 'customSize',
        widthKey: 'customSize_width',
        heightKey: 'customSize_height',
        sizeKey: key,
        condition: (params) => params[key] === 'custom'
      })
      return null
    }
    default: {
      // 穷尽检查：表加 kind 而这里不加分支即编译错（V2 default: never 语义）。
      // fork 的 PaintingParamSpec 是单接口（kind 为字面量联合），穷尽收窄落在
      // spec.kind 上而非 spec 本身。
      const _exhaustive: never = spec.kind
      return _exhaustive
    }
  }
}

/**
 * Generic param-table → form-fields dispatcher. Iterates the
 * `PAINTING_PARAM_TABLE` and turns each entry into the matching
 * `BaseConfigItem`. No per-vendor knowledge; no per-key handlers; no
 * hardcoded canonical-key list beyond the label map. Adding a new param:
 * declare it in the table with the right `PaintingParamSpec`, optionally add
 * an i18n label entry to `KEY_LABELS` above.
 *
 * `mode` is accepted for call-site compatibility (V2 per-mode support) — the
 * fork table is mode-agnostic, so it is ignored.
 */
export function imageGenerationToFields(
  _support?: { mode?: string } | undefined,
  _opts?: { mode?: string }
): BaseConfigItem[] {
  const items: BaseConfigItem[] = []
  const allSpecs: Record<string, PaintingParamSpec> = Object.fromEntries(PAINTING_PARAM_TABLE.map((s) => [s.key, s]))
  for (const spec of PAINTING_PARAM_TABLE) {
    const item = specToField(spec.key, spec, allSpecs, items)
    if (item) items.push(item)
  }
  return items
}
