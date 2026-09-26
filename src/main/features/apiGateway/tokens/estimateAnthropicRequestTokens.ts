// fork 缝：V2 的 count_tokens 估算链是「provider 权威计数（anthropic 远程）→
// 转换级 ModelMessage footprint walker → 有界原始体估算」。前两级深耦合 V2 的
// @main/ai 子系统（messageRules/messageCapabilities/tokens/footprint + 数据层
// 服务 + 凭证化远程请求），未随 fork 移植；本文件退化为 V2 自身的最内层兜底
// boundedBodyTokens（有界、恒不抛错——count_tokens 永不给客户端 500）。
// 语义提示：返回值是启发式估算，量级正确、不逐 token 精确。

import type { MessageCreateParams } from '@anthropic-ai/sdk/resources'

import { loggerService } from '@logger'

import { boundedBodyTokens } from './fallbackEstimate'
import { tokenxTokenizer } from './textTokenizer'

const logger = loggerService.withContext('GatewayTokenEstimate')

/**
 * Estimate `input_tokens` for `POST /v1/messages/count_tokens`.
 *
 * Never throws: the loosely-validated body (`content: z.unknown()`, `tools`
 * untyped) can hold arbitrarily deep/malformed payloads, and the bounded walker
 * caps both depth and work — count_tokens must not 500 a client.
 */
export async function estimateAnthropicRequestTokens(body: MessageCreateParams, _signal?: AbortSignal): Promise<number> {
  logger.warn('conversion-based estimate is not ported in the fork; using bounded raw-body estimate')
  return boundedBodyTokens(body, tokenxTokenizer)
}
