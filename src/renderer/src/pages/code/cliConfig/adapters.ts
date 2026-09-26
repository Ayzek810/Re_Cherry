import type { Document } from 'yaml'
import { isMap, isScalar } from 'yaml'

import { normalizeDeepSeekHarnessSettings, CodeCli } from '@shared/types/codeCli'
import { type CliConfigWriteFile, type FileConfiguredCli, getCliConfigTargets } from '@shared/utils/cliConfig'

import { buildHermesEnvConfig } from './builders'
import { HERMES_ENDPOINTS } from './constants'
import { parseDotenv, renderDotenvFile } from './dotenv'
import {
  getDraftFile,
  makeDraftFile,
  parseDraftFileOrThrow,
  readAndParseDraftFile,
  readConfigFilesForDraft,
  readDraftFileText
} from './draftFiles'
import { parseYamlDocumentOrThrow, parseYamlOrThrow, readConfigFiles, requireReadFile } from './file'
import type { Provider } from './providerView'
import { type HermesApiMode, HERMES_API_MODES, resolveHermesProviderInfo } from './resolvers'
import type {
  CliConfigConnection,
  CliConfigDraftBuildArgs,
  CliConfigFileDraft,
  CliConfigTarget,
  ResolvedCliConfigContext
} from './types'
import { asRecord, normalizeUrl, stringValue } from './values'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/adapters.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝（裁剪面）：V2 1208 行的九 adapter 注册表收窄到 hermes——claude/codex/opencode/gemini/
// qwen/kimi/pi/minimax 的 adapter 函数体、其专属 helper（providerNameFromKey/cherryProviderKeyFrom/
// minimax*）、managedKeys/sanitize/ownLogin/claudeModels/permissionModes 的 import 面整块删除。
// 闭包判定：从 hermesAdapter 出发沿 import/调用图收依赖——writeHermesConfig/clearHermesConfig/
// isHermesApiMode（本文件）、builders.buildHermesEnvConfig、constants.HERMES_ENDPOINTS、dotenv、
// draftFiles 五件套、file 的 yaml/read 件、resolvers 的 hermes 段 + resolveSupportedEndpointType、
// values 的 asRecord/normalizeUrl/stringValue。hermes 路径函数体一行未动（共享 helper 逐字）。

/**
 * A per-CLI config adapter: everything the config-generation layer needs to know
 * about one file-based CLI tool, gathered in one place. Adding a CLI is a single
 * new entry here (plus its file targets in `targets.ts`) rather than a new `case`
 * scattered across draft/clear/parser/sanitize/provider-matching.
 *
 * The dispatch functions in those modules are thin `getAdapter(cliTool).method()`
 * lookups; the behavior lives here.
 */
export interface CliConfigAdapter {
  /** The on-disk config files this tool owns (source of truth: `CLI_CONFIG_TARGETS`). */
  targets: readonly CliConfigTarget[]
  /** Candidate provider base URLs a stored connection may legitimately match. */
  providerBaseUrls(provider: Provider): string[]
  /** Strip a user-edited config blob down to the tool params this CLI persists. */
  sanitize(configBlob: Record<string, unknown> | undefined): Record<string, any>
  /** Build the managed config file draft(s) from resolved credentials + tool params. */
  buildDraft(args: CliConfigDraftBuildArgs, context: ResolvedCliConfigContext): Promise<CliConfigFileDraft[]>
  /** Throw if the resolved context is missing a credential this CLI requires to write. */
  assertCredentials(context: ResolvedCliConfigContext): void
  /**
   * Build the "own login" tool-param file draft (no credentials/model). Absent for
   * tools that expose no own-login config panel (OpenCode); the dispatcher throws.
   */
  buildOwnLoginDraft?(configBlob: Record<string, any>): Promise<CliConfigFileDraft[]>
  /** Re-render the draft files for an edited tool-param blob, keeping the existing connection. */
  updateDraftConfig(
    files: CliConfigFileDraft[],
    connection: CliConfigConnection,
    configBlob: Record<string, any>
  ): CliConfigFileDraft[]
  /**
   * Build the rewrites that strip every Cherry-managed key from the on-disk
   * config file(s), leaving user keys intact. Files with nothing to rewrite are
   * omitted; the caller persists the entries via `code_cli.write_config`.
   */
  buildClearFiles(): Promise<CliConfigWriteFile[]>
  /** Read the connection (baseUrl/apiKey/model) back out of the draft files. */
  extractConnection(files: CliConfigFileDraft[]): CliConfigConnection | null
  /** Read the persisted tool params back out of the draft files. */
  extractConfig(files: CliConfigFileDraft[]): Record<string, unknown> | null
}

const HERMES_API_KEY_ENV = 'CHERRY_HERMES_API_KEY'
const HERMES_API_KEY_ENV_REFERENCE = '${CHERRY_HERMES_API_KEY}'

function replaceDraftContent(
  files: CliConfigFileDraft[],
  target: CliConfigTarget,
  content: string
): CliConfigFileDraft[] {
  return files.map((file) => (file.target === target ? { ...file, content } : file))
}

function requireDraftValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Cannot update CLI config draft: missing ${label}`)
  }
  return value
}

function isHermesApiMode(value: unknown): value is HermesApiMode {
  return HERMES_API_MODES.some((apiMode) => apiMode === value)
}

const HERMES_MANAGED_MODEL_KEYS = ['provider', 'default', 'base_url', 'api_key', 'api_mode'] as const

function writeHermesConfig(
  document: Document,
  resolved: { apiKeyEnv: string; apiMode: HermesApiMode; baseUrl: string; model: string }
): string {
  const existingModel = document.get('model', true)
  // A bare `model:` parses to a null scalar node, not a missing key — an empty
  // section is a valid starting point, not a malformed mapping.
  if (existingModel == null || (isScalar(existingModel) && existingModel.value == null)) {
    document.set('model', document.createNode({}))
  } else if (!isMap(existingModel)) {
    throw new Error('invalid Hermes model config: expected an object')
  }
  document.setIn(['model', 'provider'], 'custom')
  document.setIn(['model', 'default'], resolved.model)
  document.setIn(['model', 'base_url'], normalizeUrl(resolved.baseUrl))
  document.setIn(['model', 'api_key'], resolved.apiKeyEnv)
  document.setIn(['model', 'api_mode'], resolved.apiMode)
  return document.toString()
}

function clearHermesConfig(content: string): string | null {
  const document = parseYamlDocumentOrThrow(content)
  if (document.getIn(['model', 'api_key']) !== HERMES_API_KEY_ENV_REFERENCE) return null
  for (const key of HERMES_MANAGED_MODEL_KEYS) document.deleteIn(['model', key])
  const model = document.get('model', true)
  if (isMap(model) && model.items.length === 0) document.delete('model')
  return document.toString()
}

const hermesAdapter: CliConfigAdapter = {
  targets: getCliConfigTargets(CodeCli.HERMES),
  providerBaseUrls: (provider) =>
    HERMES_ENDPOINTS.flatMap((endpoint) => {
      if (!provider.endpointConfigs?.[endpoint]?.baseUrl) return []
      const baseUrl = normalizeUrl(resolveHermesProviderInfo(provider, [endpoint]).baseUrl)
      return baseUrl ? [baseUrl] : []
    }),
  sanitize: () => ({}),
  async buildDraft(args, context) {
    const { apiKey, model, modelRecord, provider } = context
    const providerInfo = resolveHermesProviderInfo(provider, modelRecord?.endpointTypes)
    const read = await readConfigFilesForDraft(this.targets, args.files)
    const document = readAndParseDraftFile('hermes-config', parseYamlDocumentOrThrow, args.files, read)
    const envText = readDraftFileText('hermes-env', args.files, read)
    return [
      makeDraftFile(
        'hermes-config',
        writeHermesConfig(document, {
          apiKeyEnv: HERMES_API_KEY_ENV_REFERENCE,
          apiMode: providerInfo.apiMode,
          baseUrl: providerInfo.baseUrl,
          model
        }),
        read
      ),
      makeDraftFile('hermes-env', renderDotenvFile(buildHermesEnvConfig(parseDotenv(envText), apiKey), envText), read)
    ]
  },
  assertCredentials(context) {
    const { baseUrl } = resolveHermesProviderInfo(context.provider, context.modelRecord?.endpointTypes)
    if (!context.apiKey || !baseUrl) throw new Error('Hermes config is missing required fields (apiKey/baseUrl)')
  },
  updateDraftConfig(files, connection) {
    const document = parseDraftFileOrThrow('hermes-config', files, parseYamlDocumentOrThrow)
    const envText = getDraftFile(files, 'hermes-env')?.content ?? ''
    const existingApiMode = document.getIn(['model', 'api_mode'])
    const apiMode = isHermesApiMode(existingApiMode) ? existingApiMode : 'chat_completions'
    return replaceDraftContent(
      replaceDraftContent(
        files,
        'hermes-config',
        writeHermesConfig(document, {
          apiKeyEnv: HERMES_API_KEY_ENV_REFERENCE,
          apiMode,
          baseUrl: requireDraftValue(connection.baseUrl, 'Hermes base URL'),
          model: requireDraftValue(connection.model, 'Hermes model')
        })
      ),
      'hermes-env',
      connection.apiKey
        ? renderDotenvFile(buildHermesEnvConfig(parseDotenv(envText), connection.apiKey), envText)
        : envText
    )
  },
  async buildClearFiles() {
    const read = await readConfigFiles(this.targets)
    const files: CliConfigWriteFile[] = []
    const config = requireReadFile('hermes-config', read)
    if (config.content !== null) {
      try {
        const content = clearHermesConfig(config.content)
        if (content !== null) files.push({ target: 'hermes-config', content })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to parse Hermes config at ${config.path}: ${message}`)
      }
    }

    const env = requireReadFile('hermes-env', read)
    if (env.content !== null) {
      const envMap = parseDotenv(env.content)
      envMap.delete(HERMES_API_KEY_ENV)
      files.push({ target: 'hermes-env', content: renderDotenvFile(envMap, env.content) })
    }
    return files
  },
  extractConnection(files) {
    const config = parseYamlOrThrow(getDraftFile(files, 'hermes-config')?.content ?? '')
    const model = asRecord(config.model)
    if (model.api_key !== HERMES_API_KEY_ENV_REFERENCE) return null
    const env = parseDotenv(getDraftFile(files, 'hermes-env')?.content ?? '')
    return {
      baseUrl: stringValue(model.base_url),
      apiKey: stringValue(env.get(HERMES_API_KEY_ENV)),
      model: stringValue(model.default)
    }
  },
  extractConfig() {
    return {}
  }
}

/**
 * The file-based CLI tools, one adapter each. Typed as a **total** record over
 * `FileConfiguredCli` (the key set of `CLI_CONFIG_TARGETS`), so omitting an adapter
 * — or adding a new file-based CLI to `targets.ts` without one — is a compile error.
 */
export const CLI_CONFIG_ADAPTERS: Record<FileConfiguredCli, CliConfigAdapter> = {
  [CodeCli.HERMES]: hermesAdapter
}

export function getAdapter(cliTool: string): CliConfigAdapter | undefined {
  // The registry is total over `FileConfiguredCli`, but callers hold a raw string
  // cliTool that may name a provider-less/non-file tool — hence the runtime-safe lookup.
  return (CLI_CONFIG_ADAPTERS as Record<string, CliConfigAdapter | undefined>)[cliTool]
}

/** Strip a user-edited config blob to the tool params `cliTool` persists (no-op passthrough for unknown tools). */
export function sanitizeCliConfigBlob(
  cliTool: string,
  configBlob: Record<string, unknown> | undefined
): Record<string, any> {
  if (cliTool === CodeCli.DEEPSEEK_HARNESS) return normalizeDeepSeekHarnessSettings(configBlob)
  return getAdapter(cliTool)?.sanitize(configBlob) ?? asRecord(configBlob)
}
