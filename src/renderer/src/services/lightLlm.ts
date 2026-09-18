/**
 * 轻量 LLM 服务 facade（渲染进程唯一入口）。
 *
 * 一切"功能需要用一下 AI"的场景——快捷助手（流式）、话题命名/快速模型、
 * 错误诊断、健康检查，以及未来的翻译/知识库嵌入/搜索编排——统一从这里调用，
 * 禁止各功能自己直连 window.api.dshComplete / 裸 fetch 另配旁路。
 * 主进程实现见 src/main/kernel/lightLlm.ts（无会话/无 agent/无工具的一次往返），
 * wire 契约见 @shared/lightLlm/types。
 *
 * 与重路径共享 provider 路由与思考协议 compat（syncProvidersToKernel 同步面），
 * 因此开发者角色/enable_thinking 等网关修正在轻量调用上同样生效。
 *
 * 嵌入维度检查经 lightEmbeddingDimensions 走 renderer 裸 fetch（OpenAI 兼容
 * /embeddings 端点，pi-ai 不提供该协议；保留 renderer fetch 以继承系统代理路径）。
 */
import { loggerService } from '@logger'
import type { LightLlmCall, LightLlmStreamEvent, LightLlmUsage } from '@shared/lightLlm/types'

const logger = loggerService.withContext('LightLlm')

export { getEmbeddingDimensions as lightEmbeddingDimensions } from './embedding'
export type { LightLlmCall, LightLlmMessage, LightLlmStreamEvent, LightLlmUsage } from '@shared/lightLlm/types'

/**
 * 一次性补全：聚合完整文本后返回（思考缺省 off，见主进程 lightLlm）。
 * 失败抛错，由调用方决定降级策略。
 */
export async function lightComplete(call: LightLlmCall): Promise<{ text: string; usage?: LightLlmUsage }> {
  const result = (await window.api.dshComplete(call)) as { text: string; usage?: LightLlmUsage }
  return { text: result.text, usage: result.usage }
}

/**
 * 流式补全（快捷助手）：事件按 requestId 配对推给 onEvent，终态为 done 或 error。
 * 注意：错误经事件面传递，本 Promise 只反映"通道是否存活"，不反映业务成败。
 */
export async function lightStream(
  requestId: string,
  call: LightLlmCall,
  onEvent: (event: LightLlmStreamEvent) => void
): Promise<{ ok: boolean }> {
  const result = await window.api.dshStreamComplete({ requestId, ...call }, (data) => {
    onEvent(data as LightLlmStreamEvent)
  })
  logger.debug('lightLlm stream finished', { requestId, source: call.source })
  return (result ?? { ok: true }) as { ok: boolean }
}
