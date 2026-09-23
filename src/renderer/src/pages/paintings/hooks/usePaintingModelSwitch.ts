/**
 * 模型切换 hook（v0.3.3 批次4，② 薄适配）：computeModelFieldReset 保留（以
 * PAINTING_PARAM_TABLE 为输入）；跨 provider createDefaultPainting 原样；
 * isEditImageModel 判断改用 supportsPaintingEdit（paintingModelSelection）。
 */
import { loggerService } from '@logger'
import { createDefaultPainting } from '@renderer/pages/paintings/model/paintingPipeline'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { computeModelFieldReset } from '@renderer/pages/paintings/utils/computeModelFieldReset'
import { tabToImageGenerationMode } from '@renderer/pages/paintings/utils/paintingProviderMode'
import { supportsPaintingEdit } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
import { useCallback } from 'react'

const logger = loggerService.withContext('paintings/usePaintingModelSwitch')

interface UsePaintingModelSwitchInput {
  painting: PaintingData
  onPaintingChange: (updates: Partial<PaintingData>) => void
}

export type PaintingModelSelection = { providerId: string; modelId: string }

export function usePaintingModelSwitch({ painting, onPaintingChange }: UsePaintingModelSwitchInput) {
  const providers = useAppSelector((state) => state.llm.providers)
  const currentProviderId = painting.providerId
  const models: Model[] = currentProviderId
    ? (providers.find((provider) => provider.id === currentProviderId)?.models ?? [])
    : []

  return useCallback(
    async ({ providerId, modelId }: PaintingModelSelection) => {
      if (providerId === currentProviderId) {
        // Reset stale fields the old model wrote but the new one doesn't
        // accept — the form writes into `painting.params`, so the reset
        // patch lives there too. Form-hiding is driven by the new model's
        // param-table keys; this brings the underlying values in sync.
        // Returns `{}` when either model is unknown, so custom-id paintings
        // stay untouched.
        const resetPatch = await computeModelFieldReset({
          oldModelId: painting.model,
          newModelId: modelId,
          mode: tabToImageGenerationMode(painting.mode),
          currentValues: painting.params ?? {}
        })
        // Drop attached input images when the target model can't accept them:
        // the prompt-bar upload UI is gated on `supportsPaintingEdit`, so a hidden
        // attachment left over from an edit model would otherwise still be
        // sent to a generate-only model. `onPaintingChange` merges, so the
        // clear must be explicit.
        const nextModel = models.find((model) => model.id === modelId)
        const keepInputFiles = supportsPaintingEdit(nextModel)
        onPaintingChange({
          params: { ...painting.params, ...resetPatch },
          model: modelId,
          ...(keepInputFiles ? {} : { inputFiles: [] })
        } as Partial<PaintingData>)
        return
      }

      // fork 缝：模型目录就在 redux providers 里（同步可读），无 ensureProviderCatalog
      // 异步目录可失败——跨 provider 切换直接建新草稿。
      logger.debug('switching painting provider', { from: currentProviderId, to: providerId })
      const targetPainting = createDefaultPainting({ providerId })

      onPaintingChange({
        ...targetPainting,
        id: painting.id,
        files: painting.files,
        prompt: painting.prompt,
        providerId,
        mode: 'generate',
        model: modelId,
        // Switching providers resets the form context; never carry input
        // images across to a different provider's model.
        inputFiles: []
      } as Partial<PaintingData>)
    },
    [currentProviderId, models, onPaintingChange, painting]
  )
}
