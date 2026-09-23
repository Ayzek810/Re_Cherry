import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { imageGenerationToFields } from '../form/imageGenerationToFields'
import { resolveRatio, resolveSizeLabel } from '../form/paintingSize'
import type { PaintingData } from '../model/types/paintingData'

export interface PaintingSizeInfo {
  /** Aspect ratio of the selected size, or null when the model declares no size. */
  ratio: number | null
  /** Human-readable size label (e.g. `1024×1024`, `auto`), or undefined. */
  sizeLabel: string | undefined
}

/**
 * Derives the aspect ratio + size label for a painting's selected size field.
 * Both the artboard prompt bar (label) and the skeleton (ratio) read the same
 * effective value, so they share this one hook instead of each re-running the
 * derivation.
 *
 * fork 缝：V2 经 useImageGenerationSupport 派生字段（registry support）；fork
 * 已裁决走本地 PAINTING_PARAM_TABLE（imageGenerationToFields 表驱动形态，无
 * registry 查询），故直接从参数表派生。
 */
export function usePaintingSizeInfo(painting: PaintingData): PaintingSizeInfo {
  const { t } = useTranslation()
  const configItems = useMemo(() => imageGenerationToFields(), [])
  const ratio = useMemo(() => resolveRatio(painting.params, configItems), [painting.params, configItems])
  const sizeLabel = useMemo(() => resolveSizeLabel(painting.params, configItems, t), [painting.params, configItems, t])
  return { ratio, sizeLabel }
}
