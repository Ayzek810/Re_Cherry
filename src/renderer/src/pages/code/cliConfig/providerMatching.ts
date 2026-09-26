// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/providerMatching.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点一处（import 对号，函数体逐字）：Provider ← ./providerView 投影；ApiKeyEntry 为 V2
// @shared/data/types/provider 的消费面最小结构（fork 无独立 keys 表，由调用方构造）。

import { getAdapter } from './adapters'
import type { Provider } from './providerView'
import type { CliConfigConnection } from './types'
import { normalizeUrl } from './values'

/** fork 缝：V2 ApiKeyEntry 的消费面最小结构（providerMatching 只读 isEnabled/key）。 */
export interface ApiKeyEntry {
  id: string
  key: string
  isEnabled: boolean
}

function providerBaseUrls(provider: Provider, cliTool: string): string[] {
  const adapter = getAdapter(cliTool)
  if (adapter) return adapter.providerBaseUrls(provider)
  const baseUrls: string[] = []
  for (const config of Object.values(provider.endpointConfigs ?? {})) {
    const baseUrl = normalizeUrl(config?.baseUrl)
    if (baseUrl) baseUrls.push(baseUrl)
  }
  return baseUrls
}

export function cliConfigConnectionMatchesProvider(
  cliTool: string,
  connection: CliConfigConnection | null,
  provider: Provider,
  apiKeys: ApiKeyEntry[] | undefined,
  expectedModel?: string
): boolean {
  if (!connection) return true
  const baseUrl = normalizeUrl(connection.baseUrl)
  if (!baseUrl) return false

  if (!providerBaseUrls(provider, cliTool).includes(baseUrl)) {
    return false
  }

  if (expectedModel && connection.model !== expectedModel) {
    return false
  }

  if (!connection.apiKey) {
    return true
  }

  if (!apiKeys?.length) {
    return true
  }

  const validKeys = new Set<string>()
  for (const entry of apiKeys) {
    if (entry.isEnabled) validKeys.add(entry.key)
  }
  return validKeys.size === 0 ? true : validKeys.has(connection.apiKey)
}
