/**
 * 按话题记「当前回合」的运行记录——**暂停机制的唯一真相源**。
 *
 * 为什么要有它（2026-10-01 复盘）：旧的暂停靠一张「用户消息 id → 回调」的登记表 + 在消息 id
 * 被改写时迁移键 + 键失配时的兜底再发一次。三处互相牵制，结果是：
 *   - 同一个停止有两条路各发一次（两套账）；
 *   - 键迁移不更新「话题 → 键」索引 ⇒ 话题级清理清不掉改名后的登记，闭包残留；
 *   - 键一旦失配，暂停就变成"界面说停了、内核还在跑"。
 *
 * 新模型按 **话题** 记账：回合开始建立、回合结束清掉。键就是 topicId，没有迁移、没有失配、
 * 没有兜底。暂停只做两件事：把当前回合标记为已取消（界面据此立刻停、并丢弃后续增量），
 * 以及通知主进程中止在途工作（主进程自己那套按话题的中止源）。
 *
 * 与内核的关系：内核的 `agent.cancel({kind:'user'})` 是**到边界才收尾**，不是立刻掐断在途请求，
 * 所以我们不能让界面状态依赖它——界面靠本模块当帧落定，内核什么时候收尾都不影响观感。
 */

interface TopicTurn {
  /** 回合号（内核 turn 序号）。 */
  turn: number
  /** 本回合正在流式的助手消息 id（turn/start 时认领 stub 得到）。 */
  assistantMessageId?: string
  /** 用户是否已请求取消本回合。 */
  cancelled: boolean
}

const turns = new Map<string, TopicTurn>()

/** 回合开始（收到 turn/start）：建立记录并认领本回合的助手消息。 */
export function beginTurn(topicId: string, turn: number, assistantMessageId?: string): void {
  turns.set(topicId, { turn, cancelled: false, ...(assistantMessageId === undefined ? {} : { assistantMessageId }) })
}

/** 本回合的助手消息 id（投影用；未认领时为 undefined）。 */
export function currentTurnAssistantMessageId(topicId: string): string | undefined {
  return turns.get(topicId)?.assistantMessageId
}

/** 用户请求取消本回合。返回 `true` = 本次调用真的改变了状态（幂等，重复按不会重复落态）。 */
export function cancelTurn(topicId: string): boolean {
  const turn = turns.get(topicId)
  if (turn === undefined) return false
  if (turn.cancelled) return false
  turn.cancelled = true
  return true
}

/** 本回合是否已被用户取消（投影端据此丢弃后续增量）。 */
export function isTurnCancelled(topicId: string): boolean {
  return turns.get(topicId)?.cancelled === true
}

/** 回合结束（收到 turn/end）：清记录——这才是唯一的清理点，不存在"残留闭包"。 */
export function endTurn(topicId: string): void {
  turns.delete(topicId)
}

/** 当前是否存在未结束的回合（诊断/测试用）。 */
export function hasLiveTurn(topicId: string): boolean {
  return turns.has(topicId)
}
