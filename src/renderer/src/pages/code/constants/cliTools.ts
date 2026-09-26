// fork 移植自 cherry-studio v2 src/renderer/pages/code/constants/cliTools.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝（裁剪面）：CLI_TOOL_PROVIDER_MAP 只留 DEEPSEEK_HARNESS 与 HERMES 两键（V2 十四键）；
// CLI_TOOLS 再导出（V2 来自 @renderer/components/icons/CliIcon，UI 图表层）已随批次 4b 回挂
//（→ ../components/CliIcon，工具集裁 2 项）；
// GEMINI_AGGREGATOR_PROVIDERS / filterGeminiProviders / isGeminiProvider / resolveEndpointDialect
// 随 Gemini 臂删除。谓词叶子（hasEndpoint 族）按 fork Provider 形状对号改写（见缝注），
// dsh/hermes 谓词的组合逻辑逐字。PROVIDERLESS_CLI_TOOLS 空集（qoder/copilot 未移植）。

// 批次4b：UI 图表层回挂（V2 为 `import { CLI_TOOLS } from '@renderer/components/icons/CliIcon'`
// + 本文件 `export { CLI_TOOLS }`）。
export { CLI_TOOLS } from '../components/CliIcon'

import { CodeCli } from '@shared/types/codeCli'
import { isLoginBasedProvider } from '@shared/utils/provider'
import type { Provider } from '../cliConfig/providerView'

/**
 * Provider-less CLI tools: authenticate through their own login flow (OAuth /
 * device code) rather than a Cherry provider + model. They launch with a
 * working directory only — no provider config or model selection is offered.
 */
// fork 缝：空集——V2 的 Qoder CLI / GitHub Copilot CLI 未移植；消费面
// （useCodeCliPageViewProps/useLaunchDialogController，批次 4b）保持 `.has()` 调用形状。
export const PROVIDERLESS_CLI_TOOLS: ReadonlySet<CodeCli> = new Set([])

// fork 缝：V2 谓词叶子读 `endpointConfigs?.[type]?.baseUrl`（provider 级多端点表）；fork
// Provider 为 V1 形状（apiHost + anthropicApiHost，见 cliConfig/providerView 投影缝），叶子
// 对号改写。openai chat 与 responses 在 fork 共用 apiHost（无独立端点表），两谓词同值。
const hasAnthropic = (p: Provider): boolean => Boolean(p.endpointConfigs?.['anthropic-messages']?.baseUrl)
const hasChat = (p: Provider): boolean => Boolean(p.endpointConfigs?.['openai-chat-completions']?.baseUrl)
const hasResponses = (p: Provider): boolean => Boolean(p.endpointConfigs?.['openai-responses']?.baseUrl)
const hasOpenAILike = (p: Provider): boolean => hasChat(p) || hasResponses(p)

/**
 * CLI tool → supported-provider filter. Filters mirror the file injection in
 * `writeCliConfigDraft` so a provider only shows up when its CLI-compatible endpoint can
 * actually back the CLI. Judgments are based on `endpointConfigs` (the only source
 * injection reads), with one exception: Gemini CLI also admits providers
 * `isGeminiProvider` recognizes via id/`presetProviderId`/`defaultChatEndpoint`
 * plus the static aggregator allow-list, since its injection can derive the
 * Gemini URL from the default chat endpoint (see `resolveGeminiBaseUrl`).
 *
 * - Claude Code: inject reads `anthropic-messages`.
 * - Codex: inject reads `openai-responses` only. Chat-completions is no longer
 *   supported by Codex (its binary rejects `wire_api = "chat"` at parse time).
 * - OpenCode / OpenClaw: inject reads anthropic-or-openai at runtime.
 * - DeepSeek Harness: direct mode also requires API-key or keyless authentication.
 * - Gemini CLI / Antigravity: use the Gemini-format endpoint (`google-generate-content`).
 * - Qwen Code / Kimi CLI: inject reads an OpenAI-compatible endpoint.
 * - Pi: injects any endpoint supported by Pi's custom-provider schema.
 * - Hermes: injects Anthropic or OpenAI-compatible endpoints into its custom runtime.
 * - MiniMax Code: injects Anthropic or OpenAI-compatible endpoints into `custom_provider`.
 * - Qoder CLI / GitHub Copilot CLI: provider-less (authenticate via CLI login).
 */
export const CLI_TOOL_PROVIDER_MAP: Record<CodeCli, (providers: Provider[]) => Provider[]> = {
  // fork 缝：dsh 谓词组合逻辑逐字（`!isLoginBasedProvider` + 有凭据 + anthropic/openai 端点）。
  // 叶子消费对号：fork 无 authOptional/apiKeys 表（主进程缝②无 key 显式报错）→ 凭据臂收窄为
  // apiKey 非空；fork 无端点方言表（resolveEndpointDialect 未移植，协议/developer-role 修正由
  // 内核按 provider.type + compat 运行时决定）→ `(developerRole || hasAnthropic)` 臂不保留。
  [CodeCli.DEEPSEEK_HARNESS]: (providers) =>
    providers.filter(
      (p) =>
        !isLoginBasedProvider(p) &&
        (p.apiKeys?.some((key) => key.isEnabled) ?? false) &&
        (hasAnthropic(p) || hasOpenAILike(p))
    ),
  // hermes 谓词逐字（叶子见上方 fork 缝）。
  [CodeCli.HERMES]: (providers) => providers.filter((p) => hasAnthropic(p) || hasOpenAILike(p))
}
