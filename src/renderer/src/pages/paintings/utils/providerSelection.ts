/**
 * provider 纯选择器（v0.3.3 批次4，V2 providerSelection 重写为 fork 版）：
 * V2 的 OVMS 选项过滤在 fork 无此概念（路由解析在主进程 lightLlmModalities），
 * 保留"按已启用 provider 过滤 + 请求回退默认回退首个"的选择语义。
 * providers 一律作参数传入，不直接连 redux（调用方从 useAppSelector 取）。
 */
import type { Provider } from '@renderer/types'

/** 已启用且确实挂了模型的 provider id 集合（保持传入顺序）。 */
export function listEnabledProviderIds(providers: Provider[]): string[] {
  return providers.filter((provider) => provider.enabled && provider.models.length > 0).map((provider) => provider.id)
}

export function findProviderById(providers: Provider[], id: string | undefined): Provider | undefined {
  if (!id) return undefined
  return providers.find((provider) => provider.id === id)
}

/** 请求的 provider 不可用则回退默认，再回退首个可用项（V2 resolvePaintingProvider 语义）。 */
export function resolvePaintingProvider(
  requestedProvider: string | undefined,
  defaultProvider: string | undefined,
  validProviderIds: string[]
): string | undefined {
  if (requestedProvider && validProviderIds.includes(requestedProvider)) {
    return requestedProvider
  }
  if (defaultProvider && validProviderIds.includes(defaultProvider)) {
    return defaultProvider
  }
  return validProviderIds[0]
}
