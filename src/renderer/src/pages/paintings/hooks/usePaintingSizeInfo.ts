import type { ImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { imageGenerationToFields } from '../form/imageGenerationToFields'
import { resolveRatio, resolveSizeLabel } from '../form/paintingSize'
import type { PaintingData } from '../model/types/paintingData'
import { tabToImageGenerationMode } from '../utils/paintingProviderMode'

export interface PaintingSizeInfo {
  /** Aspect ratio of the selected size, or null when the model declares no size. */
  ratio: number | null
  /** Human-readable size label (e.g. `1024×1024`, `auto`), or undefined. */
  sizeLabel: string | undefined
}

/**
 * Derives the aspect ratio + size label for a painting's selected size field from
 * the model's image-generation support. Both the artboard prompt bar (label) and
 * the skeleton (ratio) read the same effective value, so they share this one hook
 * instead of each re-running the derivation.
 *
 * v0.3.3 批次6：`support` 由调用方（页面/hook 层）从 fork 目录解析后传入——
 * fork 无 V2 的 `useImageGenerationSupport`（DataApi）查询层。
 */
export function usePaintingSizeInfo(
  painting: PaintingData,
  support: ImageGenerationSupport | undefined
): PaintingSizeInfo {
  const { t } = useTranslation()
  const configItems = useMemo(
    () => imageGenerationToFields(support, { mode: tabToImageGenerationMode(painting.mode) }),
    [support, painting.mode]
  )
  const ratio = useMemo(() => resolveRatio(painting.params, configItems), [painting.params, configItems])
  const sizeLabel = useMemo(() => resolveSizeLabel(painting.params, configItems, t), [painting.params, configItems, t])
  return { ratio, sizeLabel }
}
