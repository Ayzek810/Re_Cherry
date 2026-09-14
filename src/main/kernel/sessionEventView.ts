/**
 * 会话事件的 UI 视界 —— 内核 → 渲染层的**唯一**注入判据点。
 *
 * 背景（v0.3.0-1）：dsh 的 `RuntimeContextProjection` 把动态上下文（工具面快照
 * `cherry:tool-face-state`、沙箱/审批档位等）投影成**插件源 user 消息**写进会话日志。
 * 它们是模型上下文的事实源（模型必须看到），但**不是用户发言**，一旦漏到 UI 就会
 * 变成"我没说过这句"的气泡、分支图节点或搜索命中。
 *
 * v0.3.0 的做法是在渲染层逐条封堵（投影过滤 + 直播回执跳过 + 分支树谓词 + 锚点解析），
 * 属"靠治理"：每条新消费路径都要记得再封一次，于是漏了 `searchSessions`（历史搜索会把
 * 注入快照当作 role:'user' 的命中返回）。本模块把判据收敛到唯一一处，并由内核在
 * **三个 UI 出口**统一施用，使注入事件根本不出内核——不可见靠结构，不靠各消费方自觉：
 *
 *   1. 直播广播（kernel/index.ts `registerEventForwarding`）
 *   2. 历史读取（`ctx.topicTree.uiEvents` → Dsh_TopicEvents IPC）
 *   3. 全库搜索（topics.ts `searchSessions`）
 *
 * 会话日志本身**保留**注入事件（模型可见 ⟺ 已记录；fork/重放依赖日志完整），
 * 本模块只作用于"给 UI 的那一份"。
 *
 * 判据用 dsh 自己的词汇：`source.kind === 'plugin'` 即"非用户输入"。dsh 内部
 * （agent-loop/runtime-context.ts `isOwned`）另有更窄的 `plugin === dsh-system-prompt`
 * 判据，此处**刻意取宽**：任何插件注入的 user 消息都不是用户发言，窄判据会让其他
 * 插件的注入漏进 UI。
 */
/** 事件的最小结构面（直播事件、持久化读回事件、inspect 原始行都满足）。 */
interface SessionEventLike {
  type: string
  /** 会话内序号；内核合成的伪事件（session/created 等）没有，故可选。 */
  seq?: number
  data?: unknown
}

/**
 * 该事件是否是"内核注入的插件源消息"（非用户发言，不得进入 UI 视界）。
 * @param event - 任意会话事件（或原始持久化行）。
 * @returns 是注入消息则为 true。
 */
export function isInjectedUserEvent(event: SessionEventLike): boolean {
  if (event.type !== 'user/message') return false
  // user/message 事件的 data 就是消息本体（assistant/message 才有 .message 包裹）；
  // source 类型上必填，但旧库/坏行可能缺失——缺失按"非注入"处理（保守：宁可显示）。
  const source = (event.data as { source?: { kind?: string } } | undefined)?.source
  return source?.kind === 'plugin'
}

/**
 * 过滤出 UI 视界的事件（剔除注入消息）。
 * @param events - 原始会话事件列表。
 * @returns 不含注入消息的新数组（原数组不变）。
 */
export function uiSessionEvents<T extends SessionEventLike>(events: readonly T[]): T[] {
  return events.filter((event) => !isInjectedUserEvent(event))
}

/**
 * 直播路径的单条过滤：注入消息返回 undefined，调用方据此**不广播**。
 * @param event - 单条直播会话事件。
 * @returns 可发给 UI 的事件，或 undefined（注入消息）。
 */
export function uiSessionEvent<T extends SessionEventLike>(event: T): T | undefined {
  return isInjectedUserEvent(event) ? undefined : event
}
