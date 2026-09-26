// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/types.ts
//（2026-09-24，v0.3.4-1 批次4a）。逐字；import 面对号（cliConfig 类型/Provider/Model ← 本 fork
// 的移植面）。OwnLoginConfigPanelProps 前移：V2 定义在 components/configEditPanel/
// OwnLoginConfigPanel.tsx（UI 件，批次 4b）——4a 无 UI 件，接口按 V2 原文逐字前移至此，
// 4b 挂组件时回指此处。

import type { CliConfigConnection, CliConfigFileDraft, CliConfigGatewayContext } from '@renderer/pages/code/cliConfig'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import type { CodeCli } from '@shared/types/codeCli'

import type { Model, Provider } from '@renderer/pages/code/cliConfig/providerView'
import type { UniqueModelId } from '@shared/types/uniqueModelId'

export type ConfigDraftMode = 'managed' | 'foreign'
export type ClaudeModelMode = 'common' | 'detailed'

export interface ConfigDraft {
  modelId: UniqueModelId | undefined
  config: Record<string, unknown>
  files: CliConfigFileDraft[]
  connection: CliConfigConnection | null
  mode: ConfigDraftMode
  error: string
}

export interface ConfigEditPanelSubmitValues {
  modelId?: UniqueModelId
  cliConfigModelId?: UniqueModelId
  config?: Record<string, unknown>
  cliConfigFiles?: CliConfigFileDraft[]
  cliConfigOnly?: boolean
  writePrimaryModel?: boolean
}

export interface ConfigEditPanelProps {
  onClose: () => void
  cliTool: CodeCli
  provider: Provider
  providerConfig: CliProviderConfig | null
  isCurrentProvider: boolean
  modelFilter: (model: Model) => boolean
  /** Present when `provider` is the synthetic Cherry gateway (preview key; writes use a fresh key). */
  gateway?: CliConfigGatewayContext
  /** Models currently addressable through the gateway, keyed by their real model id. */
  gatewayModels?: Map<UniqueModelId, Model>
  /** True while the queries behind `gatewayModels` are in flight — an empty map is not yet meaningful. */
  isGatewayModelsLoading?: boolean
  onSubmit: (values: ConfigEditPanelSubmitValues) => Promise<void>
}

// fork 缝：以下接口自 V2 components/configEditPanel/OwnLoginConfigPanel.tsx L26-32 逐字前移
//（UI 件本批不搬，见文件头）。
export interface OwnLoginConfigPanelProps {
  onClose: () => void
  cliTool: CodeCli
  toolName: string
  providerConfig: CliProviderConfig | null
  onSubmit: (values: { config: Record<string, unknown>; cliConfigFiles?: CliConfigFileDraft[] }) => Promise<void>
}
