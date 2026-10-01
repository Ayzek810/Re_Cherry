import { loggerService } from '@logger'
import { createSelector } from '@reduxjs/toolkit'
import { isNotSupportTextDeltaModel } from '@renderer/config/models'
import { getDefaultProvider } from '@renderer/services/AssistantService'
import { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addModel,
  addProvider,
  removeModel,
  removeProvider,
  updateModel,
  updateProvider,
  updateProviders
} from '@renderer/store/llm'
import type { Model, Provider } from '@renderer/types'
import { withoutTrailingSlash } from '@renderer/utils/api'
import { isNewApiProvider } from '@renderer/utils/provider'
import { useCallback, useMemo } from 'react'

/**
 * Normalizes provider apiHost by removing trailing slashes.
 * This ensures consistent URL concatenation across the application.
 */
function normalizeProvider<T extends Provider>(provider: T): T {
  return {
    ...provider,
    apiHost: withoutTrailingSlash(provider.apiHost)
  }
}

const selectProviders = (state: RootState) => state.llm.providers

const selectEnabledProviders = createSelector(selectProviders, (providers) =>
  providers.map(normalizeProvider).filter((p) => p.enabled)
)

const selectAllProviders = createSelector(selectProviders, (providers) => providers.map(normalizeProvider))

const providerKeyLogger = loggerService.withContext('useProvider:ProviderKeyVault')

const logger = loggerService.withContext('useProvider')

/** 写路径：renderer 侧 key 变更即时同步进 main 加密存储（持久真源）。空串/undefined = 删除。 */
async function syncProviderKeyToVault(providerId: string, apiKey: string | undefined): Promise<void> {
  try {
    if (!window.api?.providerKeys) return
    if (apiKey === undefined || apiKey.length === 0) {
      await window.api.providerKeys.remove(providerId)
    } else {
      await window.api.providerKeys.set(providerId, apiKey)
    }
  } catch (error) {
    providerKeyLogger.error(
      'Failed to sync provider apiKey to vault',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

function fireKeySync(providerId: string, apiKey: string | undefined): void {
  void syncProviderKeyToVault(providerId, apiKey)
}

export function useProviders() {
  const providers: Provider[] = useAppSelector(selectEnabledProviders)
  const dispatch = useAppDispatch()

  return {
    providers: providers || [],
    addProvider: (provider: Provider) => {
      if (provider.apiKey) fireKeySync(provider.id, provider.apiKey)
      dispatch(addProvider(provider))
    },
    removeProvider: (provider: Provider) => {
      fireKeySync(provider.id, undefined)
      dispatch(removeProvider(provider))
    },
    updateProvider: (updates: Partial<Provider> & { id: string }) => {
      if (Object.prototype.hasOwnProperty.call(updates, 'apiKey')) {
        fireKeySync(updates.id, updates.apiKey)
      }
      dispatch(updateProvider(updates))
    },
    updateProviders: (providers: Provider[]) => dispatch(updateProviders(providers))
  }
}

export function useAllProviders() {
  return useAppSelector(selectAllProviders)
}

export function useProvider(id: string) {
  const allProviders = useAppSelector(selectAllProviders)
  /**
   * 显式回落：本 hook 的 `id` 可能指不到现存 provider——调用方传的是助手当前模型
   * 的 `provider`（该 provider 可能已被删除），或空串（`InputEmbeddingDimension` 未拿到 model）。
   * 设置页需要一个 provider 对象才能渲染，故按「精确 `id` → 默认模型所属 provider → 清单第一项」
   * 依次回落，并在回落时留一条 warn。
   *
   * 这只是本 hook 的既定 UI 语义（旧行为就是回落到清单第一项），**不**适用于「按模型解析
   * provider」的场景——那里必须失败可见（`ProviderService.getProviderByModel` 的三值契约）。
   */
  const provider = useMemo(() => {
    const exactMatch = allProviders.find((p) => p.id === id)
    if (exactMatch) return exactMatch

    logger.warn('useProvider: provider id not found, falling back to the default provider', { id })

    return getDefaultProvider() ?? allProviders[0]
  }, [allProviders, id])
  const dispatch = useAppDispatch()

  const handleAddModel = useCallback(
    (model: Model) => {
      let processedModel = { ...model, supported_text_delta: !isNotSupportTextDeltaModel(model) }

      if (isNewApiProvider(provider)) {
        const endpointTypes = model.supported_endpoint_types
        if (endpointTypes && endpointTypes.length > 0) {
          processedModel = {
            ...processedModel,
            endpoint_type: endpointTypes.includes('image-generation') ? 'image-generation' : endpointTypes[0]
          }
        }
      }

      dispatch(addModel({ providerId: id, model: processedModel }))
    },
    [dispatch, id, provider]
  )

  return {
    provider,
    models: provider?.models ?? [],
    updateProvider: (updates: Partial<Provider>) => {
      if (Object.prototype.hasOwnProperty.call(updates, 'apiKey')) {
        fireKeySync(id, updates.apiKey)
      }
      dispatch(updateProvider({ id, ...updates }))
    },
    addModel: handleAddModel,
    removeModel: (model: Model) => dispatch(removeModel({ providerId: id, model })),
    updateModel: (model: Model) => dispatch(updateModel({ providerId: id, model }))
  }
}
