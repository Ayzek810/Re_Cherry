import type OpenAI from '@cherrystudio/openai'
import type { NotUndefined } from '@types'
import * as z from 'zod'

/**
 * 渲染器侧参数类型（不包含 model 和 messages，因为它们会单独处理）
 * 注意：aiCore 已移除，此文件仅保留仍在使用的类型定义
 */
/**
 * Constrains the verbosity of the model's response. Lower values will result in more concise responses, while higher values will result in more verbose responses.
 *
 * The original type unites both undefined and null.
 * When undefined, the parameter is omitted from the request.
 * When null, verbosity is explicitly disabled.
 */
export type OpenAIVerbosity = OpenAI.Responses.ResponseTextConfig['verbosity']
export type ValidOpenAIVerbosity = NotUndefined<OpenAIVerbosity>

export type OpenAIReasoningEffort = NonNullable<OpenAI.ReasoningEffort> | 'auto'
/**
 * A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process.
 *
 * The original type unites both undefined and null.
 * When undefined, the parameter is omitted from the request.
 * When null, verbosity is explicitly disabled.
 */
export type OpenAIReasoningSummary = OpenAI.Reasoning['summary']

/**
 * Options for streaming response. Only set this when you set `stream: true`.
 */
export type OpenAICompletionsStreamOptions = OpenAI.ChatCompletionStreamOptions

const AiSdkParamsSchema = z.enum([
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed'
])

export type AiSdkParam = z.infer<typeof AiSdkParamsSchema>

export const isAiSdkParam = (param: string): param is AiSdkParam => {
  return AiSdkParamsSchema.safeParse(param).success
}
