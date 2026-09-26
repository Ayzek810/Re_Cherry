// fork 移植自 cherry-studio v2 src/shared/data/preference/preferenceTypes.ts L326-372
//（2026-09-24，v0.3.4-1 批次4a）。字段名逐字；差异仅两处，均已标 `// fork 缝`：
// ① CodeCliId 在 V2 是 CODE_CLI_IDS 字面量联合，fork 按 CodeCli enum 收窄（两工具）。
// ② UniqueModelId 来自 fork @shared/types/uniqueModelId（V2 为 @shared/data/types/model）。

import type { CodeCli } from '@shared/types/codeCli'
import type { UniqueModelId } from '@shared/types/uniqueModelId'

// fork 缝：V2 为 `export const CODE_CLI_IDS = [...] as const; export type CodeCliId = (typeof CODE_CLI_IDS)[number]`
//（14 项）；fork 按保留工具从 CodeCli enum 派生，保持键空间与 CodeCli 一致。
export type CodeCliId = CodeCli

/** A per-tool provider entry, keyed by providerId in `CodeCliToolState.providers`. */
export interface CliProviderConfig {
  /**
   * Unique model id ("providerId::modelId"), or null for the two legal
   * model-less states: the own-login placeholder and a Claude detailed-models
   * config with no common model.
   */
  modelId: UniqueModelId | null
  /** User-edited tool-specific config blob. */
  config?: Record<string, unknown>
  /** Sort order in the provider list (lower = first). */
  sortIndex?: number
}

/** Per-CLI-tool state: per-provider configs (keyed by providerId) + the active one. */
export interface CodeCliToolState {
  providers: Record<string, CliProviderConfig>
  /** Currently enabled providerId (single-select). */
  current: string | null
  // fork 缝：外部终端/工作目录面 fork 未接（dsh 固定 workspace），字段保形（V2 为必填语义
  // 的可选字段，此处逐字保留 optional；消费面 useAvailableTerminals/code_cli.run 未移植）。
  /** Terminal app — an id from `code_cli.get_available_terminals`. */
  terminal?: string
  /** Working directory for this CLI tool (shared across all its providers). */
  directory?: string
}

/** Preference value for `feature.code_cli.configs`. */
export type CodeCliConfigs = Partial<Record<CodeCliId, CodeCliToolState>>
