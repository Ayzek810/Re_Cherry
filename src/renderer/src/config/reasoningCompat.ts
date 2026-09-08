import type { Model } from '@renderer/types'
import { isDeepSeekHybridInferenceModel, isSupportedThinkingTokenZhipuModel } from '@renderer/config/models'

/**
 * 第三方 OpenAI 兼容网关的"思考协议"登记表。
 *
 * pi-ai 会自动识别它内置的网关（deepseek.com / openrouter / zai / together / nvidia /
 * moonshot / ant-ling / xai 等）并按 URL 选择正确的思考参数格式；但像 硅基流动 这类
 * 引擎不识别的网关，Re_Cherry 需要在此登记它认的思考参数（compat 会被 pi-ai 按
 * per-model 逐键覆盖自动探测结果）。
 *
 * 新增提供商 = 在这里加一行：
 *   hostIncludes:  匹配 apiHost 的子串（小写）
 *   providerIds:   （可选）也可按 provider preset id 精确匹配
 *   compat:        该网关认的思考协议（值见 pi-ai compat，仅出现的键生效）
 *   appliesTo:     （可选）仅对哪些模型家族启用；缺省 = 该网关上所有推理模型
 *
 * 注意：模型"是不是推理模型/支持哪些档位"仍走通用模型家族判定（models/reasoning），
 * 这里只管"这家网关用哪种 wire 语法把它发出去"。
 */

export type ThinkingFormat =
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'together'
  | 'zai'
  | 'qwen'
  | 'chat-template'
  | 'qwen-chat-template'
  | 'string-thinking'
  | 'ant-ling'

/** 与内核 KernelModelCompatInput 对应；仅出现的键会被 pi-ai 采用。 */
export interface ProviderReasoningCompat {
  thinkingFormat?: ThinkingFormat
  supportsReasoningEffort?: boolean
  requiresReasoningContentOnAssistantMessages?: boolean
}

export interface ReasoningProviderRule {
  /** 配置条目名（日志/排查用）。 */
  name: string
  /** 命中即视为该网关：apiHost 包含任一子串（小写比较）。 */
  hostIncludes: readonly string[]
  /** 可选：也可按 provider preset id（小写）命中。 */
  providerIds?: readonly string[]
  /** 该网关认的思考参数协议。 */
  compat: ProviderReasoningCompat
  /** 仅这些模型家族启用；缺省 = 该网关上所有推理模型。 */
  appliesTo?: (model: Model) => boolean
}

/** 已登记网关。按需追加；host 越长/越具体排越前。 */
export const REASONING_PROVIDER_RULES: readonly ReasoningProviderRule[] = [
  {
    name: 'siliconflow',
    hostIncludes: ['siliconflow'],
    // 硅基流动：DeepSeek 混合思考(deepseek-chat/V3.x) 与 Zhipu 用 enable_thinking 开关，
    // 不认 reasoning_effort；reasoning_content 必须原样回传（官方文档）。
    // R1(reasoner) 不在 appliesTo 内 → 仍走通用路径（思考常开，不主动发档位参数）。
    compat: {
      thinkingFormat: 'qwen',
      supportsReasoningEffort: false,
      requiresReasoningContentOnAssistantMessages: true
    },
    appliesTo: (model) => isDeepSeekHybridInferenceModel(model) || isSupportedThinkingTokenZhipuModel(model)
  }
]

/** 按 provider（id/apiHost）命中登记条目；未命中返回 undefined（走 pi-ai 自动探测）。 */
export function matchReasoningProviderRule(provider: {
  id?: string
  apiHost?: string
}): ReasoningProviderRule | undefined {
  const host = String(provider.apiHost ?? '').toLowerCase()
  const id = String(provider.id ?? '').toLowerCase()
  return REASONING_PROVIDER_RULES.find(
    (rule) =>
      rule.hostIncludes.some((needle) => host.includes(needle)) ||
      (rule.providerIds?.some((needle) => id === needle) ?? false)
  )
}

/**
 * 给定 provider + model，返回应透传给 pi-ai 的思考协议 compat；
 * 无命中或模型家族不在 appliesTo 内 → undefined（不干预，走 pi-ai 自动探测）。
 */
export function providerReasoningCompat(provider: { id?: string; apiHost?: string }, model: Model): ProviderReasoningCompat | undefined {
  const rule = matchReasoningProviderRule(provider)
  if (rule === undefined) return undefined
  if (rule.appliesTo !== undefined && !rule.appliesTo(model)) return undefined
  return rule.compat
}
