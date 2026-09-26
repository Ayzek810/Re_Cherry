// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/launchModelId.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点三处（import 对号，函数体逐字）：
// ① i18n 缝：V2 `@renderer/i18n/resolver` → fork `@renderer/i18n`（fork 无 resolver 入口）。
// ② logger 缝：V2 `@renderer/services/LoggerService` → fork `@logger`。
// ③ toast 缝：V2 `@renderer/services/toast` → fork `window.toast`（fork 全局 toast 门面）。

import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import type { CliProviderConfig } from '@shared/types/codeCliState'

import { parseConfiguredModelId } from './applyContext'
import type { Provider } from './providerView'

const logger = loggerService.withContext('resolveLaunchModelId')

export type ConfiguredCliModelId = NonNullable<ReturnType<typeof parseConfiguredModelId>>

export interface ResolveLaunchModelIdArgs {
  enabledProvider?: Provider
  currentProviderConfig?: CliProviderConfig | null
  upsertProviderConfig: (
    providerId: string,
    partial: Pick<CliProviderConfig, 'modelId'> & Partial<CliProviderConfig>
  ) => Promise<string>
  setCurrentProvider: (providerId: string | null) => Promise<void>
  errorToastKey: string
  logLabel: string
}

/**
 * Resolve the configured model id for a managed-tool launch (DeepSeek Harness /
 * OpenClaw). Returns null when no usable selection exists — after handling the
 * failure itself: a missing provider/modelId only toasts; an unparseable
 * modelId is treated as corrupt state and additionally clears the modelId and
 * the provider selection. (`useLaunchDialogController` keeps its own variant:
 * it validates the apply context, not the modelId, and preserves gateway
 * selections for retry.)
 */
export async function resolveLaunchModelId({
  enabledProvider,
  currentProviderConfig,
  upsertProviderConfig,
  setCurrentProvider,
  errorToastKey,
  logLabel
}: ResolveLaunchModelIdArgs): Promise<ConfiguredCliModelId | null> {
  if (!enabledProvider || !currentProviderConfig?.modelId) {
    window.toast.error(i18n.t(errorToastKey))
    return null
  }
  const parsedModelId = parseConfiguredModelId(currentProviderConfig.modelId)
  if (!parsedModelId) {
    logger.error(logLabel, {
      modelId: currentProviderConfig.modelId,
      providerId: enabledProvider.id
    })
    await upsertProviderConfig(enabledProvider.id, { modelId: null })
    await setCurrentProvider(null)
    window.toast.error(i18n.t(errorToastKey))
    return null
  }
  return parsedModelId
}
