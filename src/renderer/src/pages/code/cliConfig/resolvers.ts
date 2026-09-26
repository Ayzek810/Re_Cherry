// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/resolvers.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：函数面按 hermes 依赖闭包裁剪——OpenCode/Pi/Claude/Codex/OpenAI/MiniMax 的
// resolver 与 OpenCodeNpmInfo/PiApi/MinimaxApi/modelSupportsReasoningEffort 随对应 adapter
// 整块删除；hermes 段（HERMES_API_MODES/HermesProviderInfo/resolveHermesProviderInfo）与
// 其直接私有依赖 resolveSupportedEndpointType 逐字保留。
// fork 缝②：V2 从 @shared/utils/api 导入 formatApiHost/withoutTrailingApiVersion/
// withoutTrailingSlash；fork 未移植该文件（本批触碰清单外），三函数逐字摘自 V2
// src/shared/utils/api/format.ts L7-14/L117-135/L187-200（trim 以原生 String.trim 等价，
// fork 无 es-toolkit/compat 依赖）。

import type { EndpointType, Provider } from './providerView'
import { HERMES_ENDPOINTS } from './constants'

// ---------------------------------------------------------------------------
// fork 缝②：V2 @shared/utils/api/format.ts 摘取（URL 归一工具，纯字符串处理）
// ---------------------------------------------------------------------------

/** Matches an API version at the end of a URL (with optional trailing slash). Used to detect and extract versions only from the trailing position. */
const TRAILING_VERSION_REGEX = /\/v\d+(?:alpha|beta)?\/?$/i

/** Matches a version segment in a path that starts with `/v<number>` and optionally continues with `alpha` or `beta`. The segment may be followed by `/` or the end of the string (useful for cases like `/v3alpha/resources`). */
const VERSION_REGEX = /\/v\d+(?:alpha|beta)?(?:\/|$)/i

/** Determines whether a host or path string contains a version-like segment (e.g., /v1, /v2beta). */
export function hasApiVersion(host?: string): boolean {
  if (!host) return false

  try {
    const url = new URL(host)
    return VERSION_REGEX.test(url.pathname)
  } catch {
    // If the input cannot be parsed as a full URL, treat it as a path and test directly.
    return VERSION_REGEX.test(host)
  }
}

/** Removes the trailing API version segment from a URL path. Only versions at the end of the path are removed, not versions in the middle. */
export function withoutTrailingApiVersion(url: string): string {
  return url.replace(TRAILING_VERSION_REGEX, '')
}

/** Removes the trailing slash from a URL string if it exists. */
export function withoutTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

function withoutTrailingSharp<T extends string>(url: T): T {
  return url.replace(/#$/, '') as T
}

/** Formats an API host URL by normalizing it and optionally appending an API version. */
export function formatApiHost(host?: string, supportApiVersion: boolean = true, apiVersion: string = 'v1'): string {
  const normalizedHost = withoutTrailingSlash(host?.trim() ?? '')
  if (!normalizedHost) {
    return ''
  }

  const shouldAppendApiVersion = !(normalizedHost.endsWith('#') || !supportApiVersion || hasApiVersion(normalizedHost))

  if (shouldAppendApiVersion) {
    return `${normalizedHost}/${apiVersion}`
  } else {
    return withoutTrailingSharp(normalizedHost)
  }
}

// ---------------------------------------------------------------------------
// hermes 段（逐字）
// ---------------------------------------------------------------------------

export const HERMES_API_MODES = ['anthropic_messages', 'chat_completions', 'codex_responses'] as const
export type HermesApiMode = (typeof HERMES_API_MODES)[number]

export interface HermesProviderInfo {
  apiMode: HermesApiMode
  baseUrl: string
  endpointType: EndpointType
}

function resolveSupportedEndpointType(
  provider: Provider,
  modelEndpointTypes: EndpointType[] | undefined,
  supportedEndpoints: readonly EndpointType[],
  fallbackEndpoint: EndpointType
): EndpointType {
  const hasEndpoint = (type: EndpointType) => Boolean(provider.endpointConfigs?.[type]?.baseUrl)
  const isSupported = (type: EndpointType | undefined): type is EndpointType =>
    Boolean(type && supportedEndpoints.includes(type))

  return (
    modelEndpointTypes?.find((type) => isSupported(type) && hasEndpoint(type)) ??
    (isSupported(provider.defaultChatEndpoint) && hasEndpoint(provider.defaultChatEndpoint)
      ? provider.defaultChatEndpoint
      : undefined) ??
    supportedEndpoints.find(hasEndpoint) ??
    fallbackEndpoint
  )
}

export function resolveHermesProviderInfo(provider: Provider, modelEndpointTypes?: EndpointType[]): HermesProviderInfo {
  const endpointType = resolveSupportedEndpointType(
    provider,
    modelEndpointTypes,
    HERMES_ENDPOINTS,
    'openai-chat-completions'
  )
  const rawBaseUrl = provider.endpointConfigs?.[endpointType]?.baseUrl
  const apiMode: HermesApiMode =
    endpointType === 'anthropic-messages'
      ? 'anthropic_messages'
      : endpointType === 'openai-responses'
        ? 'codex_responses'
        : 'chat_completions'
  const baseUrl =
    endpointType === 'anthropic-messages'
      ? withoutTrailingApiVersion(formatApiHost(rawBaseUrl, false))
      : formatApiHost(rawBaseUrl)

  return { apiMode, baseUrl, endpointType }
}
