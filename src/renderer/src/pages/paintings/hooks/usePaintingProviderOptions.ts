/**
 * provider 下拉选项 hook（v0.3.3 批次4，V2 usePaintingProviderOptions 重写 ~30 行）：
 * redux providers → paintingModelSelection.selectImageGenerationModels 过滤
 * → antd Select options。V2 的 OVMS 状态门在 fork 无此概念（跳过）。
 */
import { selectImageGenerationModels } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Provider } from '@renderer/types'
import { useMemo } from 'react'

export interface PaintingProviderOption {
  value: string
  label: string
}

/** 派生"挂着至少一个生图模型"的已启用 provider 下拉项（按传入顺序稳定排序）。 */
export function buildPaintingProviderOptions(providers: Provider[]): PaintingProviderOption[] {
  const options: PaintingProviderOption[] = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    const hasImageModel = selectImageGenerationModels([provider]).length > 0
    if (hasImageModel) {
      options.push({ value: provider.id, label: provider.name })
    }
  }
  return options
}

export function usePaintingProviderOptions(): PaintingProviderOption[] {
  const providers = useAppSelector((state) => state.llm.providers)
  return useMemo(() => buildPaintingProviderOptions(providers), [providers])
}
