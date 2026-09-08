import type { AzureOpenAIProvider, ProviderType } from '@renderer/types'
import { isSystemProvider, type Provider, type SystemProviderId, SystemProviderIds } from '@renderer/types'
import { CLAUDE_SUPPORTED_PROVIDERS } from '@shared/config/providers'
import { isAzureOpenAIProvider } from '@shared/provider/utils'

export const isAzureResponsesEndpoint = (provider: AzureOpenAIProvider) => {
  return provider.apiVersion === 'preview' || provider.apiVersion === 'v1'
}

export const getClaudeSupportedProviders = (providers: Provider[]) => {
  return providers.filter(
    (p) => p.type === 'anthropic' || !!p.anthropicApiHost || CLAUDE_SUPPORTED_PROVIDERS.includes(p.id)
  )
}

export const getAnthropicSupportedProviders = (providers: Provider[]) => {
  return providers.filter(isAnthropicSupportedProvider)
}

export const isAnthropicSupportedProvider = (provider: Provider) => {
  return provider.type === 'anthropic' || !!provider.anthropicApiHost
}

const NOT_SUPPORT_ARRAY_CONTENT_PROVIDERS = [
  'deepseek',
  'baichuan',
  'minimax',
  'xirang',
  'poe',
  'cephalon'
] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 message 的 content 为数组类型。 Only for OpenAI Chat Completions API.
 */
export const isSupportArrayContentProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportArrayContent !== true &&
    !NOT_SUPPORT_ARRAY_CONTENT_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const NOT_SUPPORT_DEVELOPER_ROLE_PROVIDERS = ['poe', 'qiniu'] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 developer 作为 message role。 Only for OpenAI API.
 */
export const isSupportDeveloperRoleProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isSupportDeveloperRole === true ||
    (isSystemProvider(provider) && !NOT_SUPPORT_DEVELOPER_ROLE_PROVIDERS.some((pid) => pid === provider.id))
  )
}

const NOT_SUPPORT_STREAM_OPTIONS_PROVIDERS = ['mistral'] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 stream_options 参数。Only for OpenAI API.
 */
export const isSupportStreamOptionsProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportStreamOptions !== true &&
    !NOT_SUPPORT_STREAM_OPTIONS_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDER = [
  'ollama',
  'lmstudio',
  'nvidia',
  'gpustack'
] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持使用 enable_thinking 参数来控制 Qwen3 等模型的思考。 Only for OpenAI Chat Completions API.
 */
export const isSupportEnableThinkingProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportEnableThinking !== true &&
    !NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDER.some((pid) => pid === provider.id)
  )
}

const SUPPORT_SERVICE_TIER_PROVIDERS = [SystemProviderIds.openai, SystemProviderIds.groq]
// azure-openai 系统提供商已移除；service_tier 对其的自定义支持随之失效（保留 type 级判断无意义）

/**
 * 判断提供商是否支持 service_tier 设置
 */
export const isSupportServiceTierProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isSupportServiceTier === true ||
    (isSystemProvider(provider) && SUPPORT_SERVICE_TIER_PROVIDERS.some((pid) => pid === provider.id))
  )
}

const NOT_SUPPORT_VERBOSITY_PROVIDERS = ['groq'] as const satisfies SystemProviderId[]

/**
 * Determines whether the provider supports the verbosity option.
 * Only applies to system providers that are not in the exclusion list.
 * @param provider - The provider to check
 * @returns true if the provider supports verbosity, false otherwise
 */
export const isSupportVerbosityProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportVerbosity !== true &&
    !NOT_SUPPORT_VERBOSITY_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const SUPPORT_URL_CONTEXT_PROVIDER_TYPES = ['anthropic', 'new-api'] as const satisfies ProviderType[]

export const isSupportUrlContextProvider = (provider: Provider) => {
  return SUPPORT_URL_CONTEXT_PROVIDER_TYPES.some((type) => type === provider.type)
}

/** 判断是否是使用 Gemini 原生搜索工具的 provider。官方 Gemini/Vertex 系统提供商已移除，恒为 false。 */
export const isGeminiWebSearchProvider = (_provider: Provider) => {
  return false
}

export const isNewApiProvider = (provider: Provider) => {
  return ['new-api', 'aionly'].includes(provider.id) || provider.type === 'new-api'
}

/**
 * 判断是否为 OpenAI 兼容的提供商
 * @param {Provider} provider 提供商对象
 * @returns {boolean} 是否为 OpenAI 兼容提供商
 */
export function isOpenAICompatibleProvider(provider: Provider): boolean {
  return ['openai', 'new-api', 'mistral'].includes(provider.type)
}

export function isOpenAIProvider(provider: Provider): boolean {
  return provider.type === 'openai-response'
}

export function isAwsBedrockProvider(provider: Provider): boolean {
  return provider.type === 'aws-bedrock'
}

// Re-export from shared, for backward compatibility
export {
  isAnthropicProvider,
  isAzureOpenAIProvider,
  isGeminiProvider,
  isOllamaProvider,
  isPerplexityProvider,
  isVertexProvider
} from '@shared/provider/utils'

export function isAIGatewayProvider(provider: Provider): boolean {
  return provider.type === 'gateway'
}

const NOT_SUPPORT_API_VERSION_PROVIDERS = ['github', 'copilot', 'perplexity'] as const satisfies SystemProviderId[]

export const isSupportAPIVersionProvider = (provider: Provider) => {
  if (isSystemProvider(provider)) {
    return !NOT_SUPPORT_API_VERSION_PROVIDERS.some((pid) => pid === provider.id)
  }
  return provider.apiOptions?.isNotSupportAPIVersion !== false
}

export const NOT_SUPPORT_API_KEY_PROVIDERS: readonly SystemProviderId[] = ['ollama', 'lmstudio', 'copilot']

export const NOT_SUPPORT_API_KEY_PROVIDER_TYPES: readonly ProviderType[] = []

// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
export const isSupportAnthropicPromptCacheProvider = (provider: Provider) => {
  return (
    provider.type === 'anthropic' ||
    isNewApiProvider(provider) ||
    provider.id === SystemProviderIds.aihubmix ||
    provider.id === SystemProviderIds.openrouter ||
    isAzureOpenAIProvider(provider)
  )
}
