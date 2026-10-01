import { getStoreProviders } from '@renderer/hooks/useStore'
import type { Model, Provider } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'

export function getProviderName(model?: Model) {
  const provider = getProviderByModel(model)

  if (!provider) {
    return ''
  }

  return getFancyProviderName(provider)
}

/**
 * 按模型解析 provider。**本函数是唯一的查找实现**。
 *
 * 三值契约：
 * - 命中 `model.provider` ⇒ 返回该 `Provider`；
 * - 未命中（provider 未配置、已被删除，或 `model` 为空）⇒ 返回 `undefined`。
 *
 * 调用方不得假定一定拿到 provider。需要回落默认 provider 的地方，在**调用点**显式写，
 * 并注明理由。旧实现有两份：本份纯查表，`AssistantService` 的同名副本静默回落到
 * `defaultProvider || providers[0]`——调用方无法区分「没有」与「有」。该副本已删除，
 * `AssistantService` 只转发本函数。
 */
export function getProviderByModel(model?: Model): Provider | undefined {
  const id = model?.provider
  const provider = getStoreProviders().find((p) => p.id === id)

  return provider
}

export function isProviderSupportAuth(provider: Provider) {
  const supportProviders = ['302ai', 'silicon', 'aihubmix', 'ppio', 'tokenflux', 'aionly']
  return supportProviders.includes(provider.id)
}

export function getProviderById(id: string) {
  return getStoreProviders().find((p) => p.id === id)
}
