/**
 * 生图模型目录 hook（v0.3.3 批次4，V2 usePaintingModelCatalog 重写 ~40 行）：
 * selectImageGenerationModels 扁平化 + 按 provider 分组（antd Select optGroup
 * 形态）；V2 的 SWR/ensureCatalog 异步目录在 fork 无此概念（模型表就在 redux
 * providers 里，同步可读），只保留选择与展示所需的派生面。
 */
import { selectImageGenerationModels } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Model, Provider } from '@renderer/types'
import { useMemo } from 'react'

export interface PaintingModelOption {
  value: string
  label: string
  model: Model
}

export interface PaintingModelGroup {
  providerId: string
  providerName: string
  options: PaintingModelOption[]
}

export interface PaintingModelCatalog {
  /** 平铺全量生图模型（跨 provider）。 */
  models: Model[]
  /** antd Select OptGroup 形态：按 provider 分组的选项。 */
  groups: PaintingModelGroup[]
  /** providerId → 组内选项（当前 provider 的平铺列表）。 */
  optionsByProvider: Map<string, PaintingModelOption[]>
  /** 当前选中模型（painting.model 匹配）。 */
  selectedModel: Model | undefined
}

export function usePaintingModelCatalog(providerId: string | undefined, selectedModelId: string | undefined): PaintingModelCatalog {
  const providers = useAppSelector((state) => state.llm.providers)

  return useMemo(() => {
    const enabledProviders = providers.filter((provider: Provider) => provider.enabled)
    const models = selectImageGenerationModels(enabledProviders)

    const groups: PaintingModelGroup[] = []
    const optionsByProvider = new Map<string, PaintingModelOption[]>()
    for (const provider of enabledProviders) {
      const providerModels = models.filter((model) => model.provider === provider.id)
      if (providerModels.length === 0) continue
      const options = providerModels.map((model) => ({
        value: model.id,
        label: model.name,
        model
      }))
      groups.push({ providerId: provider.id, providerName: provider.name, options })
      optionsByProvider.set(provider.id, options)
    }

    const selectedModel = selectedModelId
      ? models.find((model) => model.id === selectedModelId && (!providerId || model.provider === providerId))
      : undefined

    return { models, groups, optionsByProvider, selectedModel }
  }, [providers, providerId, selectedModelId])
}
