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
import { loggerService } from '@logger'
import { retryKernelQuery } from '@renderer/utils/topicBranch'

const logger = loggerService.withContext('KernelEventStream')

/** 直播事件载荷（内核广播 → 渲染层）。 */
export interface KernelSessionEventPayload {
  topicId: string
  event: SessionEvent
}

/**
 * 拉取一个话题的会话事件（UI 视界：注入消息已剔除）。
 * 异常原样抛出：投影层要把它降级为"内核不可用"，分支树缓存要在短重试后按失败处理
 * （绝不吞成"该分支零轮次"——那会让分支在图上凭空消失），两种语义不同，故不在此统一吞掉。
 * @param topicId - 话题（= dsh session）id。
 * @returns 该话题的事件序列。
 */
export async function fetchTopicEvents(topicId: string): Promise<SessionEvent[]> {
  const { events } = (await window.api.dshTopicEvents(topicId)) as { events: SessionEvent[] }
  return events
}

/**
 * 内核对"注册表无此行"的**确定性**失败（主进程 `openTopic`/`getTopic` 抛
 * `kernel: topic "..." not found`）。它与启动窗口的瞬时失败（handler 注册前的
 * "No handler registered"、agent 异步 resume 中的 "session is not loaded"）
 * 在界面上长得一样，但语义相反：重试一个确定性答案只会白白拖慢调用方。
 */
export function isDefinitiveTopicUnknown(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('kernel: topic') && message.includes('not found')
}

/**
 * 拉取一个话题的会话事件（带启动窗口容忍）：瞬时失败重试（默认 `KERNEL_QUERY_ATTEMPTS×DELAY`，
 * 一次点击 = 一次查询的口径）；确定性"内核无此行"（`isDefinitiveTopicUnknown`）立即按
 * **空会话**返回——那是真实状态（话题从未建册 / 已被删除），不是失败。
 * 每分支一次的批式取数（分支图家族加载）用 `options` 收窄窗口，避免 N 分支 × 启动常量的长尾。
 * @returns 事件序列；`null` = 重试窗口用尽仍不可达（"不知道"，调用方不得当作空）。
 */
export async function fetchTopicEventsWithRetry(
  topicId: string,
  options?: { attempts?: number; delayMs?: number }
): Promise<SessionEvent[] | null> {
  const answer = await retryKernelQuery(async () => {
    try {
      return await fetchTopicEvents(topicId)
    } catch (error) {
      if (isDefinitiveTopicUnknown(error)) return []
      logger.warn(
        `[kernelEventStream] failed to load events of ${topicId} (will retry if window remains)`,
        error instanceof Error ? error : new Error(String(error))
      )
      return undefined
    }
  }, options)
  return answer
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
