// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/types.ts（2026-09-24，v0.3.4-1 批次4a）。
// 逐字；import 面两处对号（Provider/Model 来自 ./providerView 投影缝，UniqueModelId 来自
// fork @shared/types/uniqueModelId），均已标 `// fork 缝`。

import type { UniqueModelId } from '@shared/types/uniqueModelId'

// fork 缝：V2 为 `@shared/data/types/{provider,model}`；fork 的 CLI 层 Provider/Model 由
// ./providerView 把 redux llm 原生形状（V1）投影成 V2 消费面形状，函数体逐字不动。
import type { Model, Provider } from './providerView'
import type { CliConfigLanguage, CliConfigTarget } from '@shared/utils/cliConfig'

export type { CliConfigLanguage, CliConfigTarget }

export interface CliConfigFileDraft {
  target: CliConfigTarget
  label: string
  path: string
  language: CliConfigLanguage
  content: string
}

export interface CliConfigConnection {
  baseUrl?: string
  apiKey?: string
  model?: string
}

/**
 * Cherry-gateway resolution override. When present, config resolution uses the synthetic
 * gateway provider (endpointConfigs → local gateway URL) + this key instead of the real
 * provider parsed from `modelId`, and writes the gateway-addressed model id — so the real
 * provider key never lands in the CLI config file.
 */
export interface CliConfigGatewayContext {
  provider: Provider
  /** The gateway secret key (`Provider.apiKeys` omits key values by schema, so it's carried here). */
  apiKey: string
}

export interface CliConfigWriteArgs {
  cliTool: string
  /** Unique model id ("providerId::modelId"). */
  modelId: UniqueModelId
  /** User-edited config blob (claude-code / codex / opencode consume it). */
  configBlob?: Record<string, unknown>
  /** Claude Code only: whether to write env.ANTHROPIC_MODEL. */
  writePrimaryModel?: boolean
  /** Present when the selected provider is the Cherry gateway (see {@link CliConfigGatewayContext}). */
  gateway?: CliConfigGatewayContext
}

/** Draft-build inputs: the write args plus an optional set of already-loaded draft files to reparse. */
export type CliConfigDraftBuildArgs = CliConfigWriteArgs & { files?: CliConfigFileDraft[] }

/**
 * Credentials/model/provider resolved from a `CliConfigWriteArgs`, shared by the
 * per-CLI adapters that build and validate config drafts.
 */
export interface ResolvedCliConfigContext {
  provider: Provider
  apiKey: string
  model: string
  /**
   * Human-readable model name for CLIs whose config carries a display-name field separate
   * from the addressing id (OpenCode `models[key].name`). Matters in gateway mode, where
   * `model` is the "providerId:apiModelId" addressing string — too opaque to display.
   */
  modelLabel?: string
  modelRecord: Model | null
  configBlob: Record<string, any>
}
