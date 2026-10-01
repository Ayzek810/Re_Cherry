import type OpenAI from '@cherrystudio/openai'
import type { Assistant } from '@renderer/types'
import { type Model, SystemProviderIds } from '@renderer/types'
import type { OpenAIVerbosity, ValidOpenAIVerbosity } from '@renderer/types/aiCoreTypes'
import { getLowerBaseModelName } from '@renderer/utils'
import { isGemini3ModelId } from '@shared/utils/model'

import {
  isGPT5FamilyModel,
  isGPT5SeriesModel,
  isGPT51SeriesModel,
  isGPT52SeriesModel,
  isOpenAIChatCompletionOnlyModel,
  isOpenAIOpenWeightModel,
  isOpenAIReasoningModel,
  isSupportVerbosityModel
} from './openai'
import { isQwenMTModel } from './qwen'
import { isClaude45ReasoningModel } from './reasoning'
import { isGenerateImageModel, isVisionModel } from './vision'
// r2-110：本文件原先 export 了 `NOT_SUPPORTED_REGEX`（只被下面的 `isSupportedModel` 使用，
// 而 `isSupportedModel` 自身只有测试引用），属"看起来是公共 API、实际无外部调用"的导出面。
// 正则本体保留（`isSupportedModel` 仍在用），只是不再对外导出。
const NOT_SUPPORTED_REGEX = /(?:^tts|whisper|speech)/i
export const GEMINI_FLASH_MODEL_REGEX = new RegExp('gemini.*-flash.*$', 'i')

export const withModelIdAndNameAsId = <T>(model: Model, fn: (model: Model) => T): { idResult: T; nameResult: T } => {
  const modelWithNameAsId = { ...model, id: model.name }
  return {
    idResult: fn(model),
    nameResult: fn(modelWithNameAsId)
  }
}

export function isSupportFlexServiceTierModel(model: Model): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)
  return (
    (modelId.includes('o3') && !modelId.includes('o3-mini')) || modelId.includes('o4-mini') || modelId.includes('gpt-5')
  )
}

// r2-110：`isSupportedFlexServiceTier` 是上面函数的纯转调别名，唯一消费者是测试
//（生产用的是 `isSupportFlexServiceTierModel`，见 `components/ServiceTierSetting`）。
// 别名已删除，测试直接指向真身。

export function isSupportedModel(model: OpenAI.Models.Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)

  return !NOT_SUPPORTED_REGEX.test(modelId)
}

/** 采样参数名（r2-103：temperature 与 top_p 的门控判据逐字相同，只差注释，故只留一份实现）。 */
export type SamplingParam = 'temperature' | 'top_p'

/**
 * Check if the model supports a sampling parameter.
 *
 * r2-103：`isSupportTemperatureModel` / `isSupportTopPModel` 原本是两份逐行相同的五段判断
 * （仅注释不同），现收敛为一份实现；两个旧名字保留为薄包装，既有消费方与测试不变。
 * `param` 今天**不**参与判断（两个参数的门控完全相同），保留在签名里是为了将来分化时
 * 只有一处需要分支。
 *
 * @param model - The model to check
 * @param assistant - The assistant whose settings may relax a gate (GPT-5.2 + reasoning_effort 'none')
 * @param param - Which sampling parameter to gate
 * @returns true if the model supports the parameter
 */
export function isSupportSamplingParam(
  model: Model | undefined | null,
  assistant: Assistant | undefined,
  param: SamplingParam
): boolean {
  // `param` 是调用点自述意图的标签：两个采样参数今天共享同一组门控（见下），
  // 故此处无需分支；将来的分化点就在这个函数里。
  void param

  if (!model) {
    return false
  }

  // OpenAI reasoning models (except open weight) don't support temperature / top_p
  if (isOpenAIReasoningModel(model) && !isOpenAIOpenWeightModel(model)) {
    if (isGPT52SeriesModel(model) && assistant?.settings?.reasoning_effort === 'none') {
      return true
    }
    return false
  }

  // OpenAI chat completion only models don't support temperature / top_p
  if (isOpenAIChatCompletionOnlyModel(model)) {
    return false
  }

  // Qwen MT models don't support temperature / top_p
  if (isQwenMTModel(model)) {
    return false
  }

  // Kimi K2.5 / K2.6 don't support custom temperature (top_p is fixed at 0.95)
  if (isKimi25OrNewerModel(model)) {
    return false
  }

  return true
}

/**
 * Check if the model supports temperature parameter
 * @param model - The model to check
 * @returns true if the model supports temperature parameter
 */
export function isSupportTemperatureModel(model: Model | undefined | null, assistant?: Assistant): boolean {
  return isSupportSamplingParam(model, assistant, 'temperature')
}

/**
 * Check if the model supports top_p parameter
 * @param model - The model to check
 * @returns true if the model supports top_p parameter
 */
export function isSupportTopPModel(model: Model | undefined | null, assistant?: Assistant): boolean {
  return isSupportSamplingParam(model, assistant, 'top_p')
}

/**
 * Check if the model enforces mutual exclusivity between temperature and top_p parameters.
 * Currently only Claude 4.5 reasoning models require this constraint.
 * @param model - The model to check
 * @returns true if temperature and top_p are mutually exclusive for this model
 */
export function isTemperatureTopPMutuallyExclusiveModel(model: Model | undefined | null): boolean {
  if (!model) return false
  return isClaude45ReasoningModel(model)
}

export function isGemmaModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('gemma-') || modelId.includes('gemma4') || model.group === 'Gemma'
}

export function isZhipuModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('glm') || model.provider === SystemProviderIds.zhipu
}

export function isMoonshotModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)
  return ['moonshot', 'kimi'].some((m) => modelId.includes(m))
}

export function isKimi25OrNewerModel(model: Model | undefined | null): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)
  // Match Kimi K2.5+ (K2.5, K2.6, ..., K2.99) and K3+ (K3, K3.x, K4, ...).
  // Older K2 variants (kimi-k2, kimi-k2-thinking, kimi-k2-0711-preview, ...) are excluded.
  return /kimi-k(?:2\.[5-9]\d*|[3-9]\d*)/.test(modelId)
}

/**
 * 按 Qwen 系列模型分组
 * @param models 模型列表
 * @returns 分组后的模型
 */
export function groupQwenModels(models: Model[]): Record<string, Model[]> {
  return models.reduce(
    (groups, model) => {
      const modelId = getLowerBaseModelName(model.id)
      // 匹配 Qwen 系列模型的前缀
      const prefixMatch = modelId.match(/^(qwen(?:\d+\.\d+|2(?:\.\d+)?|-\d+b|-(?:max|coder|vl)))/i)
      // 匹配 qwen2.5、qwen2、qwen-7b、qwen-max、qwen-coder 等
      const groupKey = prefixMatch ? prefixMatch[1] : model.group || '其他'

      if (!groups[groupKey]) {
        groups[groupKey] = []
      }
      groups[groupKey].push(model)

      return groups
    },
    {} as Record<string, Model[]>
  )
}

// 模型集合功能测试
export const isVisionModels = (models: Model[]) => {
  return models.every((model) => isVisionModel(model))
}

export const isGenerateImageModels = (models: Model[]) => {
  return models.every((model) => isGenerateImageModel(model))
}

export const isAnthropicModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  return modelId.startsWith('claude')
}

export const isDeepSeekModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  const modelName = getLowerBaseModelName(model.name)
  return modelId.includes('deepseek') || modelName.includes('deepseek')
}

const NOT_SUPPORT_TEXT_DELTA_MODEL_REGEX = new RegExp('qwen-mt-(?:turbo|plus)')

export const isNotSupportTextDeltaModel = (model: Model): boolean => {
  const modelId = getLowerBaseModelName(model.id)
  return NOT_SUPPORT_TEXT_DELTA_MODEL_REGEX.test(modelId)
}

export const isNotSupportSystemMessageModel = (model: Model): boolean => {
  return isQwenMTModel(model) || isGemmaModel(model)
}

// Verbosity settings is only supported by GPT-5 and newer models
const MODEL_SUPPORTED_VERBOSITY: readonly {
  readonly validator: (model: Model) => boolean
  readonly values: readonly ValidOpenAIVerbosity[]
}[] = [
  // Filter out models that do not support verbosity
  {
    validator: (model: Model) => !isSupportVerbosityModel(model),
    values: []
  },
  // Either only one value is supported(medium), or [low, medium, high]
  {
    validator: (model: Model) => {
      const modelId = getLowerBaseModelName(model.id)
      // chat variant: only medium is supported
      if (modelId.includes('chat')) {
        return false
      }
      // codex variant: only medium is supported before 5.3-codex
      // Since 5.3-codex, all levels are supported.
      if (modelId.includes('codex')) {
        if (isGPT5SeriesModel(model) || isGPT51SeriesModel(model) || isGPT52SeriesModel(model)) {
          return false
        }
        return true
      }
      // pro variant: all support
      return isGPT5FamilyModel(model)
    },
    values: ['low', 'medium', 'high']
  },
  // Fallback to medium
  {
    validator: isGPT5FamilyModel,
    values: ['medium']
  }
]

/**
 * Returns the list of supported verbosity levels for the given model.
 * If the model is not a GPT-5 family model, only `[undefined]` is returned.
 *
 * Verbosity levels are version-aware:
 * - GPT-5 pro: `[low, medium, high]`
 * - GPT-5 chat / old codex (5.1/5.2): `[medium]` only
 * - GPT-5.3+ codex: `[low, medium, high]`
 * - Other GPT-5 family models: `[low, medium, high]`
 *
 * @param model - The model to check
 * @returns An array of supported verbosity levels, always including `undefined` as the first element and `null` when applicable
 */
export const getModelSupportedVerbosity = (model: Model | undefined | null): OpenAIVerbosity[] => {
  if (!model || !isSupportVerbosityModel(model)) {
    return [undefined]
  }

  let supportedValues: ValidOpenAIVerbosity[] = []

  for (const { validator, values } of MODEL_SUPPORTED_VERBOSITY) {
    if (validator(model)) {
      supportedValues = [null, ...values]
      break
    }
  }

  return [undefined, ...supportedValues]
}

export const isGeminiModel = (model: Model) => {
  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('gemini')
}

export const isGrokModel = (model: Model) => {
  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('grok')
}

// r2-110：`ZHIPU_RESULT_TOKENS`（`<|begin_of_box|>` / `<|end_of_box|>`）经全仓两法确认零引用
//（符号名 + 字面量 `begin_of_box` 均只命中定义行），原注释声称"zhipu 视觉推理模型用这组
// special token 标记推理结果"与实际不符 —— 没有任何代码读取它们。按 §5.1 删除；
// 若将来真要接入解析点，应在消费处定义并补用例。
//
// r2-110：`agentModelFilter` 曾是 `isChatCandidateModel` 的纯别名，约十处生产代码直接调用
// `isChatCandidateModel`，别名本身只有测试引用（两法确认：符号名 + 别名文件搜索）。别名已删除，
// 测试直接指向真身。

export const isMaxTemperatureOneModel = (model: Model): boolean => {
  if (isZhipuModel(model) || isAnthropicModel(model) || isMoonshotModel(model)) {
    return true
  }
  return false
}

// major version, including current 3.x aliases.
// r2-104：判据本体已迁到 `@shared/utils/model` 的 `isGemini3ModelId`（生产在用的一份，
// 由 `src/main/features/apiGateway/.../AnthropicMessageConverter.ts:295` 消费）。
// 渲染侧这份现在**逐字委托**它，不再各写一份；`gemini-flash-latest` / `gemini-pro-latest`
// 别名判定在 shared 里同样存在（`packages/shared/utils/model.ts:234-237`）。
// 注意：本函数在渲染侧只被 `isGemini3ThinkingTokenModel` 使用，而后者目前只有测试引用。
export const isGemini3Model = (model: Model) => isGemini3ModelId(model.id)

// major version, including 3.x aliases
export const isGemini3ThinkingTokenModel = (model: Model) => {
  const modelId = getLowerBaseModelName(model.id)
  return isGemini3Model(model) && !modelId.includes('image')
}

/**
 * Check if the model is a Gemini 3.x Flash model
 * Matches: gemini-3-flash, gemini-3.1-flash-preview, gemini-3.2-flash-preview-09-2025, gemini-flash-latest (alias)
 * Excludes: gemini-3-flash-image-preview, gemini-3.1-flash-image-preview
 * @param model - The model to check
 * @returns true if the model is a Gemini 3.x Flash model
 */
export const isGemini3FlashModel = (model: Model | undefined | null): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)
  // Check for gemini-flash-latest alias (currently points to gemini-3-flash, may change in future)
  if (modelId === 'gemini-flash-latest') {
    return true
  }
  // Check for gemini-3-flash with optional suffixes, excluding image variants
  return /gemini-3(?:\.\d+)?-flash(?!-image)(?:-[\w-]+)*$/i.test(modelId)
}

/**
 * Check if the model is a Gemini 3.1 Flash Lite model
 * Matches: gemini-3.1-flash-lite-preview, gemini-3.1-flash-lite-preview-06-2025
 * @param model - The model to check
 * @returns true if the model is a Gemini 3.1 Flash Lite model
 */
export const isGemini31FlashLiteModel = (model: Model | undefined | null): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)
  return /gemini-3\.1-flash-lite(?:-[\w-]+)*$/i.test(modelId)
}

/**
 * Check if the model is a Gemini 3 Pro model
 * Matches: gemini-3-pro, gemini-3-pro-preview, gemini-3-pro-preview-09-2025, gemini-pro-latest (alias)
 * Excludes: gemini-3-pro-image-preview, 3.x pro versions
 * @param model - The model to check
 * @returns true if the model is a Gemini 3 Pro model
 */
export const isGemini3ProModel = (model: Model | undefined | null): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)

  // Check for gemini-3-pro with optional suffixes, excluding image variants
  return /gemini-3-pro(?!-image)(?:-[\w-]+)*$/i.test(modelId)
}

/**
 * Check if the model is a Gemini 3.1 Pro model
 * Matches: gemini-3.1-pro, gemini-3.1-pro-preview, gemini-3.1-pro-preview-09-2025, gemini-3.1-pro-latest (alias)
 * Excludes: gemini-3.1-pro-image-preview
 * @param model - The model to check
 * @returns
 */
export const isGemini31ProModel = (model: Model | undefined | null): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)
  // Check for gemini-pro-latest alias (currently points to gemini-3.1-pro, may change in future)
  if (modelId === 'gemini-pro-latest') {
    return true
  }
  // Check for gemini-3.1-pro with optional suffixes, excluding image variants
  // r2-84：`.` 必须转义——未转义时 `gemini-3x1-pro` / `gemini-3-1-pro` 也会命中
  // （同文件 `isGemini31FlashLiteModel` 已写作 `gemini-3\.1-flash-lite`）。
  return /gemini-3\.1-pro(?!-image)(?:-[\w-]+)*$/i.test(modelId)
}

/**
 * Check if the model is Claude Opus 4.6
 * Supports various formats including:
 * - Direct API: claude-opus-4-6
 * - AWS Bedrock: anthropic.claude-opus-4-6-v1
 * - GCP Vertex AI: claude-opus-4-6
 * @param model - The model to check
 * @returns true if the model is Claude 4.6 series model
 */
export function isClaude46SeriesModel(model: Model | undefined | null): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  // Supports various formats:
  // - Direct API: claude-opus-4-6, claude-opus-4.6
  // - AWS Bedrock: anthropic.claude-opus-4-6-v1
  // - GCP Vertex AI: claude-opus-4-6
  const regex = /(?:anthropic\.)?claude-(?:opus|sonnet)-4[.-]6(?:[@\-:][\w\-:]+)?$/i
  return regex.test(modelId)
}

function isClaudeOpus47OrNewerModel(model: Model | undefined | null): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  const regex = /(?:anthropic\.)?claude-opus-4[.-](?:[7-9]|[1-9]\d)(?:[@\-:][\w\-:]+)?$/i
  return regex.test(modelId)
}

/**
 * Check if the Claude model uses adaptive thinking rather than budget-token thinking.
 */
export function isSupportAdaptiveThinkingClaudeModel(model: Model | undefined | null): boolean {
  return isClaudeOpus47OrNewerModel(model)
}

/**
 * Claude sampling-parameter rejection predicates intentionally stay separate from
 * adaptive-thinking support so each API rule can diverge independently later.
 */
export function isClaudeModelRejectsTemperature(model: Model | undefined | null): boolean {
  return isClaudeOpus47OrNewerModel(model)
}

export function isClaudeModelRejectsTopP(model: Model | undefined | null): boolean {
  return isClaudeOpus47OrNewerModel(model)
}

export function isClaudeModelRejectsTopK(model: Model | undefined | null): boolean {
  return isClaudeOpus47OrNewerModel(model)
}
