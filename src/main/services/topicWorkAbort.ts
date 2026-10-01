/**
 * 按话题登记「在途的文档处理工作」，并支持按话题中止。
 *
 * 存在理由（2026-10-01 真机取证）：内核的 `topicTree.stop(id)` **不会中断正在执行的工具**。
 * 实测：用户连按 5 次暂停，`dshTopicStop` 每次都被送达内核，且内核自己的 `isRunning` 在
 * `stop()` 返回后仍为 `true`；随后那次 OCR 照常跑完并返回结果。也就是说：
 *
 * - 上次「暂停键贯通」修的是**信号的转发**（工具 → 服务 → 通道 → HTTP/worker），这一段是好的；
 * - 缺的是**中断的发起**：没有任何人把「用户按了暂停」变成一个真正会 abort 在途工作的信号。
 *
 * 本模块补上后者：文档处理这类分钟级长活在执行前把自己登记到此表（按话题），
 * `Dsh_TopicStop` 到达时直接中止该话题的全部在途工作，不等内核。中止后各执行缝的既有
 * 取消语义照旧生效（本地 OCR：cancel + 已完成页；视觉：HTTP abort + 已完成页交回）。
 *
 * 只登记「我们自己的长活」。内核若有朝一日开始中断在途工具，本表退化为冗余而无害。
 */

const byTopic = new Map<string, Set<AbortController>>()

/**
 * 登记一个在途工作。返回注销函数；调用方必须在 `finally` 里调用它。
 * @param topicId - 话题 id（会话 id）
 * @param controller - 该次工作的中断控制器
 */
export function registerTopicWork(topicId: string, controller: AbortController): () => void {
  let set = byTopic.get(topicId)
  if (set === undefined) {
    set = new Set()
    byTopic.set(topicId, set)
  }
  set.add(controller)
  return () => {
    const current = byTopic.get(topicId)
    if (current === undefined) return
    current.delete(controller)
    if (current.size === 0) byTopic.delete(topicId)
  }
}

/**
 * 中止某话题的全部在途工作。
 * @param topicId - 话题 id
 * @param reason - 交给被中止方的原因（会出现在其结果/日志里）
 * @returns 被中止的工作数（0 = 该话题当前没有在途工作）
 */
export function abortTopicWork(topicId: string, reason?: unknown): number {
  const set = byTopic.get(topicId)
  if (set === undefined) return 0
  let aborted = 0
  for (const controller of [...set]) {
    if (controller.signal.aborted) continue
    controller.abort(reason ?? new Error('topic work aborted'))
    aborted += 1
  }
  return aborted
}

/** 该话题当前登记的在途工作数（诊断/测试用）。 */
export function topicWorkCount(topicId: string): number {
  return byTopic.get(topicId)?.size ?? 0
}
