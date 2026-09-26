// fork 缝：V2 的 providerService/modelService（DataApi 数据层）→ fork 的
// Dsh_SyncProviders 快照（providerSnapshot.ts，与 deepSeekHarnessService 缝②同一
// 数据源）。五函数名与返回形状逐字保留；判定面裁剪（缝注在行内）：
// - isExternalCliProvider / isAgentOnlyProvider / getAppEdition：fork 无外部 CLI
//   provider 与版本门槛子系统，对应守卫恒假，裁掉；allowAgentOnly 参数保留形状。
// - isManagedCherryAiDefaultModel：@shared/data/presets/cherryai 未移植，按
//   packages/shared/utils/apiGateway.ts 的先例把函数体内联在本文件。
// - apiKey 单把轮换语义：fork 快照里是渲染层推送的明文 key（多 key 逗号串整体
//   透传内核），无多 key 枚举缝，故不在此展开。

import { loggerService } from '@logger'
import type { KernelProviderInput } from '@main/kernel/providers'
import { getCodeMateProvider, getCodeMateProviders } from '@main/services/codeCli/providerSnapshot'
import type { UniqueModelId } from '@shared/types/uniqueModelId'
import { formatGatewayModelId } from '@shared/utils/apiGateway'
import { isGatewayRoutableModel } from '@shared/utils/model'

const logger = loggerService.withContext('ApiGatewayModels')

/**
 * OpenAI `/v1/models`-shaped model entry surfaced by the gateway. Defined locally —
 * the renderer's old `ApiModel` type is gone in the new data model.
 */
export interface ApiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export interface ApiModelsResponse {
  object: 'list'
  data: ApiModel[]
}

/** Optional pagination filter for the gateway `/v1/models` listing. */
export interface ModelsFilter {
  offset?: number
  limit?: number
}

/**
 * fork 缝：快照 `KernelModelInput` 的网关投影 Model。字段名与 adapters/interfaces
 * 的最小结构一致；`id` 为 fork 的 "providerId::modelId" UniqueModelId，
 * `apiModelId` 是真正的 wire id（isGatewayRoutableModel 的消费面）。
 */
export interface GatewayModel {
  id: UniqueModelId
  providerId: string
  apiModelId: string
  name: string
}

export interface ResolvedGatewayModelAddress {
  providerId: string
  apiModelId: string
  uniqueModelId: UniqueModelId
  provider: KernelProviderInput
  model: GatewayModel
}

// fork 缝（内联，同 packages/shared/utils/apiGateway.ts 先例，函数体逐字）：
const CHERRYAI_PROVIDER_ID = 'cherryai'
const CHERRYAI_DEFAULT_MODEL_ID = 'qwen'

function isManagedCherryAiDefaultModel(providerId: string, modelId: string): boolean {
  return providerId === CHERRYAI_PROVIDER_ID && modelId === CHERRYAI_DEFAULT_MODEL_ID
}

function toGatewayModel(provider: KernelProviderInput, candidate: NonNullable<KernelProviderInput['models']>[number]): GatewayModel {
  return {
    id: `${provider.id}::${candidate.id}` as UniqueModelId,
    providerId: provider.id,
    apiModelId: candidate.id,
    name: candidate.name ?? candidate.id
  }
}

/** Enabled providers from the provider snapshot（`enabled === false` 已被渲染层语义过滤）。 */
function getAvailableProviders(): KernelProviderInput[] {
  try {
    return getCodeMateProviders().filter((provider) => provider.enabled !== false)
  } catch (error) {
    logger.error('Failed to list providers', error as Error)
    return []
  }
}

/** All enabled models across enabled providers, via the provider snapshot. */
function listAllAvailableModels(providers?: KernelProviderInput[]): GatewayModel[] {
  try {
    const effectiveProviders = providers ?? getAvailableProviders()
    const models: GatewayModel[] = []
    for (const provider of effectiveProviders) {
      for (const candidate of provider.models ?? []) {
        models.push(toGatewayModel(provider, candidate))
      }
    }
    return models
  } catch (error) {
    logger.error('Failed to list available models', error as Error)
    return []
  }
}

/**
 * Project a snapshot `GatewayModel` into the OpenAI `/v1/models` entry shape. The `id` is
 * the gateway-addressable `"providerId:apiModelId"`.
 */
function transformModelToOpenAi(model: GatewayModel, provider?: KernelProviderInput): ApiModel {
  return {
    id: formatGatewayModelId(model.providerId, model.apiModelId),
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: provider?.name || model.providerId
  }
}

/** Resolve a `providerId:apiModelId`. fork 缝：agent-only 守卫恒假（无该子系统）。 */
export function resolveGatewayModelAddress(modelAddress: string, allowAgentOnly = false): ResolvedGatewayModelAddress {
  void allowAgentOnly
  const sepIdx = modelAddress.indexOf(':')
  if (sepIdx <= 0 || sepIdx >= modelAddress.length - 1) {
    throw new Error(`Invalid model format: "${modelAddress}". Expected "providerId:apiModelId".`)
  }

  const providerId = modelAddress.slice(0, sepIdx)
  const apiModelId = modelAddress.slice(sepIdx + 1)
  if (isManagedCherryAiDefaultModel(providerId, apiModelId)) {
    throw new Error('CherryAI managed default model is not available through the API gateway')
  }

  const provider = getCodeMateProvider(providerId)
  if (!provider || provider.enabled === false) {
    throw new Error(`Model "${modelAddress}" is not available through the API gateway`)
  }

  const model = (provider.models ?? []).map((candidate) => toGatewayModel(provider, candidate)).find((candidate) => {
    if (!isGatewayRoutableModel(candidate)) return false
    return candidate.apiModelId === apiModelId
  })
  if (!model) {
    throw new Error(`Model "${modelAddress}" is not available through the API gateway`)
  }

  return { providerId, apiModelId, uniqueModelId: model.id, provider, model }
}

/**
 * Build the OpenAI `/v1/models` listing: enabled models across enabled providers,
 * deduplicated by gateway id and optionally paginated. Never throws — returns an empty
 * list on failure so the route stays resilient.
 */
export async function getModels(filter: ModelsFilter = {}): Promise<ApiModelsResponse> {
  try {
    const providers = getAvailableProviders()
    const models = listAllAvailableModels(providers)

    // Deduplicate by the gateway-addressable id ("providerId:apiModelId").
    const uniqueModels = new Map<string, ApiModel>()
    for (const model of models) {
      const provider = providers.find((p) => p.id === model.providerId)
      // Same routable-model predicate as the renderer's gateway picker — the
      // listing must never advertise a model the proxy cannot route.
      // fork 缝：V2 的 isAgentOnlyProvider 跳步随子系统裁掉（fork 恒不命中）。
      if (!isGatewayRoutableModel(model)) {
        continue
      }

      const apiModel = transformModelToOpenAi(model, provider)
      if (!uniqueModels.has(apiModel.id)) {
        uniqueModels.set(apiModel.id, apiModel)
      }
    }

    let modelData = Array.from(uniqueModels.values())
    const offset = filter.offset ?? 0
    const limit = filter.limit
    if (limit !== undefined) {
      modelData = modelData.slice(offset, offset + limit)
    } else if (offset > 0) {
      modelData = modelData.slice(offset)
    }

    logger.info('Models retrieved', { returned: modelData.length, discovered: models.length })
    return { object: 'list', data: modelData }
  } catch (error) {
    logger.error('Error getting models', error as Error)
    return { object: 'list', data: [] }
  }
}
