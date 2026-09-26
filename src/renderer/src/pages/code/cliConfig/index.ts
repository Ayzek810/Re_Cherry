// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/index.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：出口面按 hermes 依赖闭包收窄——claudeModels/permissionModes/ownLogin 相关出口与
// sanitize 面随对应文件整块移除（barrel 仅 re-export，无逻辑，V2 同则）。

export { sanitizeCliConfigBlob } from './adapters'
export { parseConfiguredModelId, resolveCliConfigApplyContext } from './applyContext'
export { clearCliConfig } from './clear'
export {
  isOwnLoginConfigurable,
  readCliConfigDraft,
  readCliConfigFiles,
  readOwnLoginCliConfigDraft,
  writeCliConfigDraft,
  writeOwnLoginCliConfigDraft
} from './draft'
export { validateCliConfigDraftForWrite } from './draftFiles'
export { formatCliConfigDraftFile, updateCliConfigDraftConfig } from './draftUpdater'
export { gatewayExpectedModel, gatewayModelIdFromAddress } from './gatewayModel'
export { resolveLaunchModelId } from './launchModelId'
export { extractConfigFromCliConfigDraft, extractConnectionFromCliConfigDraft } from './parser'
export { cliConfigConnectionMatchesProvider, type ApiKeyEntry } from './providerMatching'
export type {
  CliConfigConnection,
  CliConfigFileDraft,
  CliConfigGatewayContext,
  CliConfigLanguage,
  CliConfigTarget,
  CliConfigWriteArgs
} from './types'
export { safeCreateUniqueModelId } from './values'
