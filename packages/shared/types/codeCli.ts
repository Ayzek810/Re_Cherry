// fork 移植自 cherry-studio v2 src/shared/types/codeCli.ts（2026-09-24，v0.3.4-1）。
// 逐字率自证见 docs/v0.3.4_doc.md；改动仅两处裁剪，均已标 `// fork 缝`。

export enum CodeCli {
  // fork 缝：内置项按用户裁决裁剪为 deepseek-harness + hermes 两项（原 14 项）。
  DEEPSEEK_HARNESS = 'deepseek-harness',
  HERMES = 'hermes'
}

export const DEEPSEEK_HARNESS_AGENT_PRESETS = ['inherit', 'standard', 'code', 'minimal'] as const
export type DeepSeekHarnessAgentPreset = (typeof DEEPSEEK_HARNESS_AGENT_PRESETS)[number]

export const DEEPSEEK_HARNESS_PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type DeepSeekHarnessPermissionMode = (typeof DEEPSEEK_HARNESS_PERMISSION_MODES)[number]

export interface DeepSeekHarnessSettings {
  /** Keep the existing DSH setting, or select one of the shipped coding presets. */
  agentPreset: DeepSeekHarnessAgentPreset
  /** Default permission applied to sessions created by the managed process. */
  permissionMode: DeepSeekHarnessPermissionMode
}

export const DEFAULT_DEEPSEEK_HARNESS_SETTINGS: Readonly<DeepSeekHarnessSettings> = Object.freeze({
  agentPreset: 'inherit',
  permissionMode: 'workspace-write'
})

export function isDeepSeekHarnessAgentPreset(value: unknown): value is DeepSeekHarnessAgentPreset {
  return DEEPSEEK_HARNESS_AGENT_PRESETS.includes(value as DeepSeekHarnessAgentPreset)
}

export function isDeepSeekHarnessPermissionMode(value: unknown): value is DeepSeekHarnessPermissionMode {
  return DEEPSEEK_HARNESS_PERMISSION_MODES.includes(value as DeepSeekHarnessPermissionMode)
}

export function normalizeDeepSeekHarnessSettings(value: unknown): DeepSeekHarnessSettings {
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    agentPreset: isDeepSeekHarnessAgentPreset(settings.agentPreset)
      ? settings.agentPreset
      : DEFAULT_DEEPSEEK_HARNESS_SETTINGS.agentPreset,
    permissionMode: isDeepSeekHarnessPermissionMode(settings.permissionMode)
      ? settings.permissionMode
      : DEFAULT_DEEPSEEK_HARNESS_SETTINGS.permissionMode
  }
}

/**
 * Reserved virtual provider id for the code-CLI "use your own login" option.
 * Persisted as `CodeCliToolState.current` in place of a real provider id so the
 * launch gate passes while no Cherry provider is injected — the CLI then falls
 * back to its own stored account login. Namespaced so it never collides with a
 * real provider id.
 */
export const CLI_OWN_LOGIN_PROVIDER_ID = 'cherry:cli-own-login'

/**
 * CLI tools that can run through their own account login (OAuth) instead of a
 * Cherry provider + API key. These surface the virtual "own login" option and,
 * when it is selected, launch provider-less (no credential injection). Distinct
 * from the provider-less tools (Qoder / Copilot), which never accept a Cherry
 * provider at all.
 */
// fork 缝：保留工具（dsh/hermes）均非 login-capable，集合保持空以维持调用点形状。
export const LOGIN_CAPABLE_CLI_TOOLS: ReadonlySet<CodeCli> = new Set([])

/**
 * Reserved virtual provider id for the code-CLI "Cherry Gateway" option. Like the
 * own-login entry it is a page-local synthetic provider (never persisted to the
 * providers store), but instead of running credential-less it injects the local
 * API gateway's URL + key into the CLI config so the real provider key never
 * lands on disk and any model is reachable through the gateway's dialect
 * conversion. Namespaced so it never collides with a real provider id.
 */
export const CLI_API_GATEWAY_PROVIDER_ID = 'cherry:api-gateway'

/**
 * Fixed ASCII provider-name segment for the gateway in CLI config keys (`cherry-gateway`).
 * The synthetic provider's card title is the localized "统一网关" (Unified Gateway), which would
 * sanitize to an empty/garbled segment; this stable name keeps the on-disk key clean and
 * locale-independent.
 */
export const CLI_API_GATEWAY_PROVIDER_NAME = 'gateway'

export function isApiGatewayProviderId(id: string): boolean {
  return id === CLI_API_GATEWAY_PROVIDER_ID
}

/**
 * CLI tools that can be backed by the Cherry API gateway. The gateway exposes
 * Anthropic (`/v1/messages`), OpenAI (`/v1/chat/completions`, `/v1/responses`),
 * and Gemini (`/v1beta/models/*`) dialects, so Gemini CLI and Antigravity route
 * through the gateway too. OpenClaw is excluded because it has its own gateway sync path.
 */
// fork 缝：集合按保留工具裁剪（原 11 项 → 2 项）。
export const GATEWAY_CAPABLE_CLI_TOOLS: ReadonlySet<CodeCli> = new Set([CodeCli.HERMES, CodeCli.DEEPSEEK_HARNESS])
