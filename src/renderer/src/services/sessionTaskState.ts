/**
 * 任务面板投影（v0.4.6-1）：todo/goal 的 UI 状态唯一来源 = 内核会话日志折叠。
 *
 * 事件词汇（dsh 原生，last-wins 整值替换）：
 * - `todo/write`：`{ todos: TodoItem[] }` 整表快照（无 id——每次写入整表替换）。
 * - `goal/change`：GoalChangeMeta 整值后状态（operation 'clear' 为墓碑 → goal 置空）。
 *
 * 数据通道走 kernelEventStream（渲染层内核事件唯一取数入口）：重放
 * `fetchTopicEventsWithRetry` + 直播 `subscribeKernelSessionEvents` 增量折叠。
 * 本模块是投影不是真相源——任何状态都能从事件序列重新折叠出来（不变量 2）。
 *
 * 边界（r2-15/r2-16/r2-48）：
 * - 重放结果按折叠前捕获的 `version` 合并——直播在重放期间推进过就直接丢弃重放整值，
 *   不让旧快照覆盖新状态；
 * - `null`（重试窗口耗尽 = "不知道"）与 reject 都**不**记为已重放，并允许有限次重试
 *   （见 `REPLAY_MAX_ATTEMPTS`）——否则该话题的历史 todo/goal 在整个进程生命周期内都不会再折叠；
 * - `states` 按 LRU 上限收口（见 `STATES_MAX`），空快照且无人订阅的条目在退订时释放。
 */
import type { GoalPhase, GoalSnapshot } from '@deepseek-ai/dsh-goal/types'
import type { TodoItem } from '@deepseek-ai/dsh-session/types'
import { loggerService } from '@logger'

import { fetchTopicEventsWithRetry, subscribeKernelSessionEvents } from './kernelEventStream'

const logger = loggerService.withContext('SessionTaskState')

export interface TopicTaskSnapshot {
  /** 当前整表任务清单；`null` = 该话题从未写过 todo。 */
  todos: TodoItem[] | null
  /** 当前持久目标；`null` = 未创建或已 clear。 */
  goal: GoalSnapshot | null
  /** 当前目标已进行的续论轮数（无目标时 0）。 */
  goalRounds: number
}

export type { GoalPhase }

const EMPTY: TopicTaskSnapshot = { todos: null, goal: null, goalRounds: 0 }

/**
 * `states` 的 LRU 条目上限（r2-48）：`Map` 的迭代顺序即插入顺序，重放/直播折叠时
 * 先 `delete` 再 `set` 把条目提到尾部，读快照不改变顺序。条目只是投影缓存——
 * 淘汰只影响"下次读要不要重新折叠"，不影响内核会话日志（不变量 2）。
 */
export const STATES_MAX = 200

/** 单个话题的重放尝试上限（r2-15）：达到后不再自动重试，避免"不可达"话题被无限重拉。 */
export const REPLAY_MAX_ATTEMPTS = 3

const states = new Map<string, { snapshot: TopicTaskSnapshot; version: number }>()
const listeners = new Map<string, Set<() => void>>()
/**
 * topicId → 重放记账（r2-15）：
 * - `attempts`：已发起的重放次数（成功不回退，作为限次闸门）；
 * - `replayed`：是否已成功重放过（成功后不再重放）。
 *
 * 失败（`null` / reject）只保留计数、**不**写 `replayed`，因此该话题的历史状态还有机会被折叠；
 * 计数达到 {@link REPLAY_MAX_ATTEMPTS} 后停止自动重试。
 */
const replayState = new Map<string, { attempts: number; replayed: boolean }>()
let liveBound = false

function getMutable(topicId: string): TopicTaskSnapshot {
  return states.get(topicId)?.snapshot ?? EMPTY
}

/** 状态版本（r2-16）：重放落地与直播事件写入时对照，判定"直播是否已推进过"。 */
function getVersion(topicId: string): number {
  return states.get(topicId)?.version ?? 0
}

function replace(topicId: string, next: TopicTaskSnapshot): void {
  const current = states.get(topicId)
  // LRU：先摘后插，把刚写过的条目提到迭代尾部（最近使用）。
  if (current !== undefined) states.delete(topicId)
  states.set(topicId, { snapshot: next, version: (current?.version ?? 0) + 1 })
  while (states.size > STATES_MAX) {
    const oldest = states.keys().next().value
    if (oldest === undefined || oldest === topicId) break
    states.delete(oldest)
  }
  listeners.get(topicId)?.forEach((listener) => listener())
}

/** 单事件折叠（直播与重放共用；未知事件原样跳过）。 */
export function foldTaskEvent(state: TopicTaskSnapshot, event: { type: string; data?: unknown }): TopicTaskSnapshot {
  if (event.type === 'todo/write') {
    const todos = (event.data as { todos?: unknown } | undefined)?.todos
    if (!Array.isArray(todos)) {
      logger.warn('task panel: todo/write event carried no list; ignored')
      return state
    }
    return { ...state, todos: todos as TodoItem[] }
  }
  if (event.type === 'goal/change') {
    const meta = event.data as
      | { operation?: string; goal?: GoalSnapshot; roundsStarted?: number; cleared?: unknown }
      | undefined
    if (meta?.operation === 'clear') {
      return { ...state, goal: null, goalRounds: 0 }
    }
    if (meta?.goal === undefined || meta.goal === null) {
      logger.warn('task panel: goal/change event carried no snapshot; ignored')
      return state
    }
    return {
      ...state,
      goal: meta.goal,
      goalRounds: typeof meta.roundsStarted === 'number' ? meta.roundsStarted : state.goalRounds
    }
  }
  return state
}

function applyEvent(topicId: string, event: { type: string; data?: unknown }): void {
  // r2-16：同一 `Map` 条目只读一次——比较基准与折叠输入必须是同一个快照。
  const current = getMutable(topicId)
  const next = foldTaskEvent(current, event)
  if (next !== current) {
    replace(topicId, next)
  }
}

/**
 * 确保一个话题的投影已启动（重放一次 + 全局直播订阅一次）。幂等。
 *
 * 重放在**失败**（`null` / reject）时不记为已重放，并按 {@link REPLAY_MAX_ATTEMPTS}
 * 限次重试；`null` 是"不知道"，既不当作空状态，也不当作"已重放"（三值契约）。
 */
export function ensureTopicTasks(topicId: string): void {
  const replay = replayState.get(topicId)
  if (replay?.replayed !== true && (replay?.attempts ?? 0) < REPLAY_MAX_ATTEMPTS) {
    replayState.set(topicId, { attempts: (replay?.attempts ?? 0) + 1, replayed: false })
    // r2-16：在**发起重放时**记下状态版本。重放是异步的（启动窗口内可能几秒），回调落地时
    // 直播可能已经把这些历史事件之后的整值写进来了——那种情况下重放整值（旧快照 + 旧事件）
    // 必须丢弃，否则任务面板会回退到历史状态。基线必须在发起时取，回调里取会漏掉间隔期。
    const versionAtRequest = getVersion(topicId)
    void fetchTopicEventsWithRetry(topicId)
      .then((events) => {
        if (events === null) {
          // 重试窗口用尽仍不可达（"不知道"）：不当作空状态——保留当前投影并如实记日志。
          // **不写 `replayed`**：下次挂载还可再试（限次），否则该话题的历史 todo/goal 永不重放。
          logger.warn(`task panel: events of ${topicId} unreachable within retry window; keeping current projection`)
          return
        }
        if (getVersion(topicId) !== versionAtRequest) {
          logger.warn(`task panel: live events advanced during replay of ${topicId}; replay result dropped`)
          return
        }
        let state = getMutable(topicId)
        for (const event of events) {
          state = foldTaskEvent(state, event)
        }
        // 折叠是同步的：这里再核一次版本，覆盖"折叠过程中恰好有直播写入"的窗口。
        if (getVersion(topicId) !== versionAtRequest) {
          logger.warn(`task panel: live events advanced during replay of ${topicId}; replay result dropped`)
          return
        }
        const settled = replayState.get(topicId)
        replayState.set(topicId, { attempts: settled?.attempts ?? 1, replayed: true })
        replace(topicId, state)
      })
      .catch((error: unknown) => {
        // reject 同样是"没有答案"：不写 `replayed`，下次挂载可再试（限次）。
        logger.warn(`task panel: replay failed for ${topicId}`, error as Error)
      })
  }
  if (!liveBound) {
    liveBound = true
    subscribeKernelSessionEvents(({ topicId, event }) => applyEvent(topicId, event))
  }
}

/** React 订阅缝（useSyncExternalStore 用）：返回退订函数。 */
export function subscribeTopicTasks(topicId: string, onChange: () => void): () => void {
  let set = listeners.get(topicId)
  if (set === undefined) {
    set = new Set()
    listeners.set(topicId, set)
  }
  set.add(onChange)
  return () => {
    set?.delete(onChange)
    if (set !== undefined && set.size === 0) {
      listeners.delete(topicId)
      // r2-48：无人订阅且投影为空的条目没有保留价值——释放它（含 todos/goal 投影）。
      // 只删"空"条目：非空快照仍要留给后续进入该话题的挂载点。
      const entry = states.get(topicId)
      if (entry !== undefined && entry.snapshot === EMPTY) {
        states.delete(topicId)
      }
    }
  }
}

/** React 快照缝：引用稳定（仅在事件改变状态时更新）。 */
export function getTopicTaskSnapshot(topicId: string): TopicTaskSnapshot {
  return getMutable(topicId)
}

/** 诊断/测试缝（r2-48）：当前缓存的投影条目数。用于验证 {@link STATES_MAX} 确实生效。 */
export function getTopicTaskStateCount(): number {
  return states.size
}

/**
 * 诊断/测试缝（r2-15）：该话题是否已经成功重放过。`false` = 历史 todo/goal 还会被折叠
 * （失败/未尝试），`true` = 本进程内不再重放。
 */
export function isTopicTaskReplayComplete(topicId: string): boolean {
  return replayState.get(topicId)?.replayed === true
}

/** 诊断/测试缝（r2-15）：该话题已发起的重放尝试次数（限次闸门用）。 */
export function getTopicTaskReplayAttempts(topicId: string): number {
  return replayState.get(topicId)?.attempts ?? 0
}
