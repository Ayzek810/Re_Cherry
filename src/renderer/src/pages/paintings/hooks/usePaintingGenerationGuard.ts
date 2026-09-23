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

    // fork 缝：A4 —— V2 此处是 `await ensureCurrentCatalog()`（异步模型目录，DataApi 可失败），故 V2 有
    // 可达的 `catalog_error` 分支。fork 的目录就是 redux providers 上的同步过滤
    // （`selectImageGenerationModels` = filter/flatMap，纯函数、不抛），没有任何"目录失败态"，
    // 原 try/catch 的 `catalog_error` 是死分支（静态门禁与覆盖率都照不出来）。删掉分支形状，
    // 不再伪造错误态；`PaintingGenerationGuardReason` 仍与 V2 同形保留 `catalog_error`
    // （presentPaintingGenerationGuardFeedback 的同名分支依旧存在，等未来接上真异步目录即可复发）。
    const ensuredOptions: Model[] = selectImageGenerationModels([provider])

    const ensuredOption = ensuredOptions.find((option) => option.id === modelId)
    if (!ensuredOption) {
      return Promise.resolve({ ok: false, reason: 'model_unavailable' })
    }

    return Promise.resolve({ ok: true })
  }, [modelId, providerId, providers])

  return { validateBeforeGenerate }
}
