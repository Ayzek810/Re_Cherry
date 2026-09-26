// fork 缝：V2 的 @main/i18n（t / getAppLanguage / SUPPORTED_LANGUAGES）、
// @shared/data/preference/preferenceTypes（LanguageVarious）、
// @shared/utils/languages（languageNativeNameMap）均未随 fork 移植。
// fork 主进程无 i18n 运行时（渲染层 i18next 只服务 UI），OpenAPI 文档文案
// 仅英文（fork 单语决策）——本地语言常量 + 英文键表；Scalar 的语言切换器
// 仍可用（?lang= 影响 Scalar chrome locale），文档正文恒英文。
// 文案原值逐字取自 V2 src/main/i18n/locales/en-us.json 的 apiGateway.docs.*
// 段（knowledge/mcp 相关槽随路由裁剪未保留）。

import { configManager } from '@main/services/ConfigManager'
import type { LanguageVarious } from '@types'

export const SUPPORTED_LANGUAGES: readonly LanguageVarious[] = ['en-US', 'zh-CN']

export function getAppLanguage(): LanguageVarious {
  const configured = configManager.getLanguage()
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(configured) ? configured : 'en-US'
}

export const languageNativeNameMap: Record<LanguageVarious, string> = {
  'en-US': 'English',
  'zh-CN': '简体中文'
}

const DOCS_STRINGS: Record<string, string> = {
  'apiGateway.docs.description':
    'OpenAI-, Anthropic- and Gemini-compatible HTTP API for Cherry Studio, plus Cherry-specific endpoints (models)',
  'apiGateway.docs.language_switcher_label': 'Documentation language',
  'apiGateway.docs.operations.chat_completions':
    'Create a chat completion. Request and response bodies follow the OpenAI Chat Completions format; set `stream: true` for incremental output.',
  'apiGateway.docs.operations.count_tokens': 'Estimate how many input tokens a set of Anthropic-format messages uses.',
  'apiGateway.docs.operations.generate_content':
    "Generate content through Gemini's `generateContent` method. Request and response bodies follow the Gemini API format; `streamGenerateContent` is served on the same path.",
  'apiGateway.docs.operations.health': 'Service health, current time and version. No authentication required.',
  'apiGateway.docs.operations.info': 'API name, version and the main endpoints. No authentication required.',
  'apiGateway.docs.operations.list_models':
    'List the models available through this gateway, in the OpenAI models format.',
  'apiGateway.docs.operations.messages':
    'Create a message. Request and response bodies follow the Anthropic Messages format; set `stream: true` for incremental output.',
  'apiGateway.docs.operations.responses': 'Create a response. Request and response bodies follow the OpenAI Responses format.',
  'apiGateway.docs.tags.anthropic':
    "Anthropic-compatible endpoints. Point an Anthropic SDK at this gateway's base URL to use them.",
  'apiGateway.docs.tags.cherry': "Cherry Studio's own endpoints: service info and health check.",
  'apiGateway.docs.tags.gemini': 'Gemini-compatible endpoints, served under `/v1beta` like the upstream API.',
  'apiGateway.docs.tags.openai':
    "OpenAI-compatible endpoints. Point an OpenAI SDK at this gateway's base URL to use them."
}

/**
 * OpenAPI 文档键表查询。签名位保持 V2 的 t(key, options, lang)（路由层调用逐字）；
 * lang 仅影响 Scalar chrome locale，键表恒英文。
 */
export function t(key: string, _options: undefined, _lang: LanguageVarious): string {
  return DOCS_STRINGS[key] ?? key
}
