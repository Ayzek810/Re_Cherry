/**
 * 生成前 guard（v0.3.3 批次4，② 薄适配）：provider_enabled/model_missing/
 * model_unavailable/catalog_error 四类 guard 保留；数据源换 fork——
 * provider/模型从 redux providers + paintingModelSelection 取（无 DataApi 目录）。
 */
import { selectImageGenerationModels } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Model, Provider } from '@renderer/types'
import { useCallback } from 'react'

import type { PaintingData } from '../model/types/paintingData'

export type PaintingGenerationGuardReason =
  | 'provider_disabled'
  | 'model_missing'
  | 'model_unavailable'
  | 'catalog_error'

export type PaintingGenerationGuardResult =
  | { ok: true }
  | { ok: false; reason: PaintingGenerationGuardReason; error?: Error }

interface UsePaintingGenerationGuardInput {
  painting: Pick<PaintingData, 'providerId' | 'mode' | 'model'>
}

export function usePaintingGenerationGuard({ painting }: UsePaintingGenerationGuardInput) {
  const providers = useAppSelector((state) => state.llm.providers)
  const providerId = painting.providerId
  const modelId = painting.model

  const validateBeforeGenerate = useCallback((): Promise<PaintingGenerationGuardResult> => {
    const provider: Provider | undefined = providers.find((p) => p.id === providerId)
    // Keyless-permissive: no API-key pre-check (consistent with chat/agent) — a
    // provider that needs a key fails naturally at request time. Enablement is
    // still enforced; PaintingModelSelector does not pre-block when disabled.
    if (!provider || !provider.enabled) {
      return Promise.resolve({ ok: false, reason: 'provider_disabled' })
    }

    if (!modelId) {
      return Promise.resolve({ ok: false, reason: 'model_missing' })
    }

    // fork 缝：模型目录就在 redux providers 里（同步可读），无 DataApi 目录可失败
    // ——catalog_error 仅在模型选择器抛错时由调用方注入，这里保留分支形状。
    let ensuredOptions: Model[]
    try {
      ensuredOptions = selectImageGenerationModels([provider])
    } catch (error) {
      return Promise.resolve({
        ok: false,
        reason: 'catalog_error',
        error: error instanceof Error ? error : new Error('Failed to load painting models')
      })
    }

    const ensuredOption = ensuredOptions.find((option) => option.id === modelId)
    if (!ensuredOption) {
      return Promise.resolve({ ok: false, reason: 'model_unavailable' })
    }

    return Promise.resolve({ ok: true })
  }, [modelId, providerId, providers])

  return { validateBeforeGenerate }
}
