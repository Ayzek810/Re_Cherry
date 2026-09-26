// fork 缝：与 estimateAnthropicRequestTokens 同因——V2 的转换级 Gemini footprint
// walker（@main/ai/messages + tokens 子树）未随 fork 移植，退化为有界原始体估算
//（V2 自身的最内层兜底），恒不抛错。

import { loggerService } from '@logger'

import { boundedBodyTokens } from './fallbackEstimate'
import { tokenxTokenizer } from './textTokenizer'

const logger = loggerService.withContext('GatewayGeminiTokenEstimate')

/**
 * Estimate `totalTokens` for a Gemini `:countTokens` request.
 *
 * Never throws: the bounded walker caps depth and work — countTokens must not
 * 500 a client. Heuristic by design (magnitude-correct, not token-exact).
 */
export async function estimateGeminiRequestTokens(body: unknown, _modelString: string, _signal?: AbortSignal): Promise<number> {
  logger.warn('conversion-based estimate is not ported in the fork; using bounded raw-body estimate')
  return boundedBodyTokens(body, tokenxTokenizer)
}
