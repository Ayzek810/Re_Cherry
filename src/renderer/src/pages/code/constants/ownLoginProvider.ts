import { CLI_OWN_LOGIN_PROVIDER_ID } from '@shared/types/codeCli'

import type { Provider } from '../cliConfig/providerView'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/constants/ownLoginProvider.ts
//（2026-09-24，v0.3.4-1 批次4b）。fork 缝：V2 的 Provider 为 @shared/data/types/provider 全形状
//（authType/authMethods/reportsActualCost/settings + DEFAULT_PROVIDER_SETTINGS），fork 渲染层
// CLI 宇宙的 Provider 为 cliConfig/providerView 投影面——合成条目按投影形状给最小占位
//（endpointConfigs 空表 + 空 apiKeys + 空 models）。消费点（useCodeCliPageViewProps 的
// prependedProviders）在 fork 为不可达面（LOGIN_CAPABLE_CLI_TOOLS 空集），保留仅为形状。

/**
 * Synthetic, page-local provider entry for the "use the CLI's own login" option.
 * It occupies a slot in a login-capable tool's provider list so the option can be
 * selected and reordered exactly like a real provider — but it is never persisted
 * to the providers store and never backs a real request. The row is rendered by
 * `OwnLoginCard` (not `ProviderCard`), so most of these fields are placeholders
 * that never surface in the UI; they exist only to satisfy the `Provider` shape.
 */
export const OWN_LOGIN_PROVIDER: Provider = {
  id: CLI_OWN_LOGIN_PROVIDER_ID,
  name: 'CLI own login',
  endpointConfigs: {},
  apiKeys: [],
  models: []
}
