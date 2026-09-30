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

const states = new Map<string, { snapshot: TopicTaskSnapshot; version: number }>()
const listeners = new Map<string, Set<() => void>>()
const replayed = new Set<string>()
let liveBound = false

function getMutable(topicId: string): TopicTaskSnapshot {
  return states.get(topicId)?.snapshot ?? EMPTY
}

function replace(topicId: string, next: TopicTaskSnapshot): void {
  const current = states.get(topicId)
  states.set(topicId, { snapshot: next, version: (current?.version ?? 0) + 1 })
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
  const next = foldTaskEvent(getMutable(topicId), event)
  if (next !== getMutable(topicId)) {
    replace(topicId, next)
  }
}

/** 确保一个话题的投影已启动（重放一次 + 全局直播订阅一次）。幂等。 */
export function ensureTopicTasks(topicId: string): void {
  if (!replayed.has(topicId)) {
    replayed.add(topicId)
    void fetchTopicEventsWithRetry(topicId)
      .then((events) => {
        if (events === null) {
          // 重试窗口用尽仍不可达（"不知道"）：不当作空状态——保留当前投影并如实记日志，
          // 下一轮直播事件仍会增量推进。
          logger.warn(`task panel: events of ${topicId} unreachable within retry window; keeping current projection`)
          return
        }
        let state = getMutable(topicId)
        for (const event of events) {
          state = foldTaskEvent(state, event)
        }
        replace(topicId, state)
      })
      .catch((error: unknown) => {
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
    }
  }
}

/** React 快照缝：引用稳定（仅在事件改变状态时更新）。 */
export function getTopicTaskSnapshot(topicId: string): TopicTaskSnapshot {
  return getMutable(topicId)
}
