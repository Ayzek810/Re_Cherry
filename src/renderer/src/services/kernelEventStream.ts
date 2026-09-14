/**
 * 内核事件流的**唯一取数入口**（渲染层）。
 *
 * v0.3.0-1：注入的插件源消息（RuntimeContextProjection 的工具面快照、审批/沙箱档位标注等）
 * 已在核嘴边被剔除（`src/main/kernel/sessionEventView.ts`），因此本模块只做通道搬运，
 * **不含任何可见性判据**——不可见靠结构，不靠每个消费方各自记得再封一次
 * （v0.3.0 逐条封堵时漏掉了历史搜索，注入快照会以 role:'user' 的形式出现在结果里）。
 *
 * 约定：渲染层任何需要内核会话事件的新代码都从本模块取数，不得直接触碰
 * `window.api.dshTopicEvents` / `window.api.dshOnSessionEvent`——由
 * `src/main/kernel/__tests__/kernelEventAccess.test.ts` 的门禁测试保证这两条裸通道只在这里出现。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 直播事件载荷（内核广播 → 渲染层）。 */
export interface KernelSessionEventPayload {
  topicId: string
  event: SessionEvent
}

/**
 * 拉取一个话题的会话事件（UI 视界：注入消息已剔除）。
 * 异常原样抛出：投影层要把它降级为"内核不可用"，分支树缓存要降级为空家族，
 * 两种语义不同，故不在此统一吞掉。
 * @param topicId - 话题（= dsh session）id。
 * @returns 该话题的事件序列。
 */
export async function fetchTopicEvents(topicId: string): Promise<SessionEvent[]> {
  const { events } = (await window.api.dshTopicEvents(topicId)) as { events: SessionEvent[] }
  return events
}

/**
 * 订阅内核直播事件（UI 视界）；返回退订函数。
 * @param callback - 每条直播事件的接收方。
 * @returns 退订函数。
 */
export function subscribeKernelSessionEvents(callback: (payload: KernelSessionEventPayload) => void): () => void {
  return window.api.dshOnSessionEvent((payload) => {
    callback(payload as KernelSessionEventPayload)
  })
}
