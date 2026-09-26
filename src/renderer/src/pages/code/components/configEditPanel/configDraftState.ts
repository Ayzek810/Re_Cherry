import type { CliConfigConnection, CliConfigFileDraft, CliConfigGatewayContext } from '@renderer/pages/code/cliConfig'
import {
  extractConfigFromCliConfigDraft,
  extractConnectionFromCliConfigDraft,
  readCliConfigDraft,
  readCliConfigFiles,
  sanitizeCliConfigBlob,
  updateCliConfigDraftConfig
} from '@renderer/pages/code/cliConfig'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import type { CodeCli } from '@shared/types/codeCli'
import type { UniqueModelId } from '@shared/types/uniqueModelId'
import type { Model } from '../../cliConfig/providerView'
import { isUniqueModelId } from '../../cliConfig/values'
import type { ConfigDraft } from './types'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/configDraftState.ts
//（2026-09-24，v0.3.4-1 批次4b）。缝点两处，快照/初载/受管草稿构造逐字：
// ① Claude 臂删除：claudeModelMode 判定（hasClaudeDetailedModels）、detailed 模式选项解析
//   （getClaudeContextModelId）与 commonModeWillClearDetailedModels 脏检查项随 claudeModels.ts
//   未移植裁剪（见 4a useConfigMetadata 缝④）；resolveManagedDraftOptions 收敛为单返回臂。
// ② 类型缝：CliProviderConfig ← @shared/types/codeCliState；UniqueModelId ← @shared 对口面；
//   Model ← providerView 投影。

export interface ManagedDraftOptions {
  cliConfigModelId?: UniqueModelId
  writePrimaryModel?: boolean
}

export function createDraftSnapshot(draft: ConfigDraft): string {
  return JSON.stringify({
    modelId: draft.modelId ?? '',
    config: draft.config,
    files: draft.files.map((file) => ({
      target: file.target,
      content: file.content
    })),
    mode: draft.mode,
    connection: draft.connection
      ? {
          baseUrl: draft.connection.baseUrl ?? '',
          apiKey: draft.connection.apiKey ?? '',
          model: draft.connection.model ?? ''
        }
      : null
  })
}

export function createInitialConfigDraftState(
  cliTool: CodeCli,
  providerConfig: CliProviderConfig | null | undefined
): {
  modelId: UniqueModelId | undefined
  config: Record<string, unknown>
  draft: ConfigDraft
} {
  const modelId = providerConfig && isUniqueModelId(providerConfig.modelId) ? providerConfig.modelId : undefined
  const config = sanitizeCliConfigBlob(cliTool, providerConfig?.config ?? {})
  return {
    modelId,
    config,
    draft: {
      modelId,
      config,
      files: [],
      connection: null,
      mode: 'managed',
      error: ''
    }
  }
}

export function isConfigDraftDirty({
  initialDraftSnapshot,
  nextDraft
}: {
  initialDraftSnapshot: string | undefined
  nextDraft: ConfigDraft
}): boolean {
  return createDraftSnapshot(nextDraft) !== initialDraftSnapshot
}

export function resolveManagedDraftOptions(
  _cliTool: CodeCli,
  _providerId: string,
  config: Record<string, unknown>,
  modelId: UniqueModelId | undefined,
  gatewayModels?: Map<UniqueModelId, Model>
): ManagedDraftOptions {
  void config
  void gatewayModels
  return {
    cliConfigModelId: modelId,
    writePrimaryModel: true
  }
}

export async function createManagedConfigDraft({
  cliTool,
  modelId,
  config,
  files,
  options = {},
  gateway
}: {
  cliTool: CodeCli
  modelId: UniqueModelId | undefined
  config: Record<string, unknown>
  files?: CliConfigFileDraft[]
  options?: ManagedDraftOptions
  gateway?: CliConfigGatewayContext
}): Promise<ConfigDraft> {
  const cliConfigModelId = options.cliConfigModelId ?? modelId
  try {
    const nextFiles = cliConfigModelId
      ? await readCliConfigDraft({
          cliTool,
          modelId: cliConfigModelId,
          configBlob: config,
          files,
          writePrimaryModel: options.writePrimaryModel,
          gateway
        })
      : updateCliConfigDraftConfig(cliTool, files ?? [], config)
    return {
      modelId,
      config,
      files: nextFiles,
      connection: null,
      mode: 'managed',
      error: ''
    }
  } catch (error) {
    return {
      modelId,
      config,
      files: files ?? [],
      connection: null,
      mode: 'managed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function loadInitialConfigDraft({
  cliTool,
  providerId,
  isCurrentProvider,
  initialModelId,
  initialConfig,
  initialDraftSeed,
  connectionMatchesProvider,
  gateway,
  gatewayModels
}: {
  cliTool: CodeCli
  providerId: string
  isCurrentProvider: boolean
  initialModelId: UniqueModelId | undefined
  initialConfig: Record<string, unknown>
  initialDraftSeed: ConfigDraft
  connectionMatchesProvider: (connection: CliConfigConnection | null, expectedModelId?: UniqueModelId) => boolean
  gateway?: CliConfigGatewayContext
  gatewayModels?: Map<UniqueModelId, Model>
}): Promise<ConfigDraft> {
  const initialDraftOptions = resolveManagedDraftOptions(
    cliTool,
    providerId,
    initialConfig,
    initialModelId,
    gatewayModels
  )
  let rawFiles: CliConfigFileDraft[] = []

  try {
    rawFiles = await readCliConfigFiles(cliTool, { includeEmpty: true })

    if (!initialModelId && !initialDraftOptions.cliConfigModelId) {
      return {
        ...initialDraftSeed,
        files: rawFiles
      }
    }

    const connection = extractConnectionFromCliConfigDraft(cliTool, rawFiles)

    if (isCurrentProvider && connection && !connectionMatchesProvider(connection, initialModelId)) {
      return {
        modelId: initialModelId,
        config: extractConfigFromCliConfigDraft(cliTool, rawFiles) ?? initialConfig,
        files: rawFiles,
        connection,
        mode: 'foreign',
        error: ''
      }
    }

    if (isCurrentProvider && !rawFiles.length) {
      return initialDraftSeed
    }

    return createManagedConfigDraft({
      cliTool,
      modelId: initialModelId,
      config: initialConfig,
      files: rawFiles,
      options: initialDraftOptions,
      gateway
    })
  } catch (error) {
    return {
      ...initialDraftSeed,
      files: rawFiles,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
