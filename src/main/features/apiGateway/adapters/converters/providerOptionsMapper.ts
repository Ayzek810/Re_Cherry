/**
 * Provider Options Mapper — fork passthrough seam
 *
 * fork 缝：V2 原文 214 行（见参考树 cherry-studio v2
 * src/main/features/apiGateway/adapters/converters/providerOptionsMapper.ts）
 * 深耦合 V2 ai 运行时的 5 个独有模块（@data/services/ProviderRegistryService、
 * @main/ai/provider/endpoint、@main/ai/utils/options、
 * @main/ai/utils/reasoningSerializers、@shared/ai/reasoning，均不移植）。
 *
 * fork 引擎（ctx.llm.stream / pi-ai）从路由配置消费 provider 特定行为
 * （thinkingFormat / compat 等），不消费 V2 providerOptions——此映射面在
 * fork 引擎下无消费者。故保留导出签名、函数体透传：一律返回 undefined，
 * 调用方（四个 MessageConverter 的 extractProviderOptions）得到与"用户未配
 * 置推理"等价的结果。
 *
 * 副作用（已在版本报告记账）：Gemini 多轮思考签名的 providerOptions 注入缺失，
 * 多轮 Gemini 经网关的思考连续性降级。
 */

import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages'

import type { ReasoningEffort } from '@cherrystudio/openai/resources'

import type { Model, Provider } from '../interfaces'

// Re-export for use by message converters.
export type { ReasoningEffort }

/**
 * fork 缝：V2 取自 @shared/types/aiSdk（未移植），原定义为
 * `ReasoningEffort | 'default'`，其中 ReasoningEffort 为 provider-registry
 * 词表（'none'…'xhigh' | 'max' | 'ultra' | 'auto'）。此处以
 * @cherrystudio/openai 的 Shared.ReasoningEffort（'none'…'xhigh' | null）为基，
 * 补齐 registry 独有的 'max' | 'ultra' | 'auto' 与 'default' 哨兵，使
 * anthropic-sdk 0.81 `output_config.effort`（'high'|'low'|'max'|'medium'|null）
 * 可赋值——透传函数体不消费该词表，仅签名位。
 */
type ReasoningEffortOption = ReasoningEffort | 'default' | 'max' | 'ultra' | 'auto'

type GatewayReasoningEffort = ReasoningEffortOption
type GeminiThinkingConfig = { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: string }

/** Map an Anthropic thinking configuration to the resolved model's target dialect. */
export function mapAnthropicThinkingToProviderOptions(
  provider: Provider,
  model: Model,
  config: MessageCreateParams['thinking'],
  effort?: GatewayReasoningEffort | null,
  maxTokens?: number
): ProviderOptions | undefined {
  void provider
  void model
  void config
  void effort
  void maxTokens
  return undefined
}

/** Map a Gemini-native thinking configuration to the resolved model's target dialect. */
export function mapGeminiThinkingToProviderOptions(
  provider: Provider,
  model: Model,
  thinkingConfig: GeminiThinkingConfig,
  maxTokens?: number
): ProviderOptions | undefined {
  void provider
  void model
  void thinkingConfig
  void maxTokens
  return undefined
}

/** Map OpenAI-style reasoning_effort to the resolved model's target dialect. */
export function mapReasoningEffortToProviderOptions(
  provider: Provider,
  model: Model,
  reasoningEffort?: ReasoningEffort,
  maxTokens?: number
): ProviderOptions | undefined {
  void provider
  void model
  void reasoningEffort
  void maxTokens
  return undefined
}
