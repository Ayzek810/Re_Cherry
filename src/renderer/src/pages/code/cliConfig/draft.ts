// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/draft.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点三处，已标 `// fork 缝`：
// ① 数据缝：V2 经 DataApi（dataApiService.get('/providers/…') 等）按需查询；fork 无 DataApi，
//   provider/apiKeys/modelRecord 从 redux llm 快照（getStoreProviders）同步读出，并经
//   ./providerView 投影成 V2 形状后进入本层——读取点集中在本文件 resolveContext。
// ② 凭据缝：V2 的 authOptional/OLLAMA 占位令牌面（fork 主进程缝②"无 key 显式报错"）与
//   OLLAMA_FALLBACK_TOOLS 表不搬——effectiveApiKey 即 provider apiKey（空则由
//   assertCredentials 抛错），语义见 DeepSeekHarnessService fork 缝②。
// ③ IPC 缝：`ipcApi.request('code_cli.write_config', …)` → `window.api.codeCli.writeConfig`。
// 其余（draft 机制/写队列/own-login 面）逐字。

import { loggerService } from '@logger'
import { getStoreProviders } from '@renderer/hooks/useStore'
import type { Provider as ForkProvider } from '@renderer/types'
import { formatGatewayModelId } from '@shared/utils/apiGateway'
import { FILE_CONFIGURED_CLI_TOOLS, getCliConfigTargets, isFileConfiguredCli } from '@shared/utils/cliConfig'

import { getAdapter, sanitizeCliConfigBlob } from './adapters'
import { makeDraftFile, readDraftFileText, validateCliConfigDraftForWrite } from './draftFiles'
import { readConfigFiles } from './file'
import { toCliModel, toCliProvider } from './providerView'
import type {
  CliConfigDraftBuildArgs,
  CliConfigFileDraft,
  CliConfigGatewayContext,
  CliConfigWriteArgs,
  ResolvedCliConfigContext
} from './types'
import { firstApiKey, isUniqueModelId } from './values'
import { parseUniqueModelId } from '@shared/types/uniqueModelId'
import type { UniqueModelId } from '@shared/types/uniqueModelId'

const logger = loggerService.withContext('writeCliConfigDraft')

/**
 * Renderer-side CLI config drafting for the file-based CLI tools.
 *
 * This module builds and validates the config-file drafts; the disk write is
 * main-process (`code_cli.write_config`, which owns path resolution, atomic
 * 0600 writes, and snapshot/rollback). Injection runs at the "enable config"
 * trigger (see CodeCliPage); launch (`ipcApi.request('code_cli.run', …)`) is
 * terminal-only. OpenClaw config is handled by the main-process
 * OpenClawService, so this module is a no-op for it.
 */

async function resolveContext(args: CliConfigWriteArgs): Promise<ResolvedCliConfigContext | null> {
  if (!FILE_CONFIGURED_CLI_TOOLS.has(args.cliTool)) return null
  if (!isUniqueModelId(args.modelId)) {
    throw new Error(`Invalid model id: ${args.modelId}`)
  }
  const { providerId, modelId: model } = parseUniqueModelId(args.modelId)

  // fork 缝①：store 读取点（V2 为 dataApiService.get）。fork provider 真源是 redux llm 快照；
  // 读取是同步的，无 V2 的并发 Promise.all 形状（V2 注释"three reads are independent"随
  // DataApi 面一并失效）。
  const providers = getStoreProviders()

  // Cherry gateway: resolve against the synthetic gateway provider + gateway key instead of the
  // real provider, and write the gateway-addressed model id ("providerId:apiModelId"). The real
  // provider key is never fetched, so it can't land in the CLI config file. Model metadata is still
  // read by the real model id (for contextWindow etc.); a failed read degrades to the raw model id.
  if (args.gateway) {
    const modelRecord = findForkModel(providers, providerId, model)
    if (!modelRecord) {
      logger.warn(`Failed to load model record for ${args.modelId}`)
    }
    return {
      provider: args.gateway.provider,
      apiKey: args.gateway.apiKey,
      model: formatGatewayModelId(providerId, modelRecord?.apiModelId ?? model),
      // The gateway addressing id is UUID-prefixed and unreadable; label with the model's
      // display name (falling back to the bare model id) for CLIs that show one.
      modelLabel: modelRecord?.name ?? modelRecord?.apiModelId ?? model,
      modelRecord,
      configBlob: sanitizeCliConfigBlob(args.cliTool, args.configBlob)
    }
  }

  const forkProvider = providers.find((p) => p.id === providerId)
  if (!forkProvider) {
    throw new Error(`Provider not found: ${providerId}`)
  }
  const provider = toCliProvider(forkProvider)
  const modelRecord = findForkModel(providers, providerId, model)

  // fork 缝②：V2 的 apiKey 解析为 `firstApiKey(apiKeysRes?.keys)`（DataApi keys 表）＋
  // authOptional/Ollama 占位回退；fork provider 无独立 keys 表（单 apiKey 字段）且无
  // authOptional 面——直接取 apiKey，空值由 assertCredentials 抛错。
  const effectiveApiKey = firstApiKey(provider.apiKeys)

  return {
    provider,
    apiKey: effectiveApiKey,
    model,
    modelLabel: modelRecord?.name ?? model,
    modelRecord,
    configBlob: sanitizeCliConfigBlob(args.cliTool, args.configBlob)
  }
}

/** fork 缝①：从 redux llm 快照按 providerId + 原始模型 id 找模型并投影（找不到 → null，V2 同形）。 */
function findForkModel(
  providers: readonly ForkProvider[],
  providerId: string,
  rawModelId: string
): ReturnType<typeof toCliModel> | null {
  const forkModel = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === rawModelId)
  return forkModel ? toCliModel(forkModel) : null
}

export async function readCliConfigFiles(
  cliTool: string,
  options: { includeEmpty?: boolean } = {}
): Promise<CliConfigFileDraft[]> {
  const targets = getCliConfigTargets(cliTool)
  const read = await readConfigFiles(targets)
  const files = targets.map((target) => makeDraftFile(target, readDraftFileText(target, undefined, read), read))
  return options.includeEmpty || files.some((file) => file.content.trim()) ? files : []
}

export async function readCliConfigDraft(args: CliConfigDraftBuildArgs): Promise<CliConfigFileDraft[]> {
  const context = await resolveContext(args)
  if (!context) return []
  return buildCliConfigDraftFiles(args, context)
}

async function buildCliConfigDraftFiles(
  args: CliConfigDraftBuildArgs,
  context: ResolvedCliConfigContext
): Promise<CliConfigFileDraft[]> {
  return (await getAdapter(args.cliTool)?.buildDraft(args, context)) ?? []
}

/**
 * Per-tool required-credential checks (missing apiKey/baseUrl). Run only on the
 * immediate-write path, before anything is read/written — preview
 * (`readCliConfigDraft`) tolerates incomplete credentials and just renders
 * around them, so it must never call this.
 */
function assertCliConfigCredentials(cliTool: string, context: ResolvedCliConfigContext): void {
  getAdapter(cliTool)?.assertCredentials(context)
}

export async function writeCliConfigDraft(args: {
  cliTool: string
  modelId?: UniqueModelId
  configBlob?: Record<string, unknown>
  files?: CliConfigFileDraft[]
  writePrimaryModel?: boolean
  gateway?: CliConfigGatewayContext
}): Promise<unknown> {
  let files = args.files
  if (args.modelId) {
    const writeArgs: CliConfigDraftBuildArgs = {
      cliTool: args.cliTool,
      modelId: args.modelId,
      configBlob: args.configBlob,
      writePrimaryModel: args.writePrimaryModel,
      gateway: args.gateway,
      files: args.files
    }
    const context = await resolveContext(writeArgs)
    if (!context) return
    assertCliConfigCredentials(args.cliTool, context)
    // Gateway: always rebuild so the freshly-resolved gateway key/model is (re)injected — the preview
    // draft may carry a stale/empty key built before the gateway started. Passing `args.files` as the
    // merge base keeps the user's hand-edited unmanaged fields (managed credential/model are
    // overwritten). Real providers keep writing an explicitly-supplied hand-edited draft through verbatim.
    if (args.gateway || !files?.length) {
      files = await buildCliConfigDraftFiles(writeArgs, context)
    }
  } else if (!files?.length) {
    throw new Error('Cannot write CLI config without a model id')
  }
  validateCliConfigDraftForWrite(files)

  if (!isFileConfiguredCli(args.cliTool)) {
    throw new Error(`${args.cliTool} does not use config files`)
  }
  // fork 缝③：V2 为 `await ipcApi.request('code_cli.write_config', { cliTool, files })`。
  const result = (await window.api.codeCli.writeConfig({
    cliTool: args.cliTool,
    files: files.map(({ target, content }) => ({ target, content }))
  })) as { success: boolean; message?: string }
  if (!result.success) {
    throw new Error(result.message)
  }
  logger.info(`Applied ${args.cliTool} config`)
  return undefined
}

/**
 * Login-capable tools whose "own login" entry also exposes a config panel (tool
 * params only, no model/credentials) expose a `buildOwnLoginDraft` on their
 * adapter. Qoder / GitHub Copilot are fully provider-less and never reach here;
 * OpenCode has no own-login config panel.
 */
export function isOwnLoginConfigurable(cliTool: string): boolean {
  return Boolean(getAdapter(cliTool)?.buildOwnLoginDraft)
}

/**
 * Build the tool-param config file for an "own login" selection: the user's tool
 * params (permission mode / effort / toggles) with no credentials or model, so
 * the CLI keeps using its own stored account login. The per-tool builders strip
 * every Cherry-managed credential/model/provider key and re-apply only the tool
 * params. Credential-only side files (Codex `auth.json`, Gemini `.env`) carry no
 * tool params and are scrubbed by `clearCliConfig` on select, not here.
 */
async function buildOwnLoginConfigDraftFiles(
  cliTool: string,
  configBlob: Record<string, unknown>
): Promise<CliConfigFileDraft[]> {
  const adapter = getAdapter(cliTool)
  if (!adapter?.buildOwnLoginDraft) {
    throw new Error(`Own-login config is not supported for ${cliTool}`)
  }
  return adapter.buildOwnLoginDraft(sanitizeCliConfigBlob(cliTool, configBlob))
}

/**
 * Build (but do not write) the "own login" CLI config file draft — the raw file
 * preview shown in the config panel's advanced editor, so power users can hand-
 * edit `settings.json` on top of the tool params.
 */
export async function readOwnLoginCliConfigDraft(args: {
  cliTool: string
  configBlob?: Record<string, unknown>
}): Promise<CliConfigFileDraft[]> {
  return buildOwnLoginConfigDraftFiles(args.cliTool, args.configBlob ?? {})
}

/**
 * Apply an "own login" config to the CLI config file without writing any
 * credentials/model. Writes hand-edited `files` verbatim when provided,
 * otherwise rebuilds them from the tool params. Reuses `writeCliConfigDraft`'s
 * files path (validate → code_cli.write_config), bypassing the
 * credential-requiring `resolveContext`.
 */
export async function writeOwnLoginCliConfigDraft(args: {
  cliTool: string
  configBlob?: Record<string, unknown>
  files?: CliConfigFileDraft[]
}): Promise<void> {
  const files = args.files?.length
    ? args.files
    : await buildOwnLoginConfigDraftFiles(args.cliTool, args.configBlob ?? {})
  await writeCliConfigDraft({ cliTool: args.cliTool, files })
}
