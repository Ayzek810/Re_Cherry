import { loggerService } from '@logger'

const logger = loggerService.withContext('AbortController')

export const abortMap = new Map<string, (() => void)[]>()

/**
 * 话题 → 当前登记的键。r2-13：`abortMap` 原先只增不减（每条用户消息一个闭包），
 * 以「同一话题同时只有一个在途回合」为不变量，发新回合时把该话题上一回合的登记摘掉，
 * 使表大小随**活跃话题数**而非消息数增长。真正的中止仍然只在回合内（消息为
 * processing/pending）被调用，所以摘掉已结束回合的登记不影响"停止"按钮。
 */
const abortKeysByTopic = new Map<string, string>()

/** 登记中止回调。`topicId` 可选：给了就按话题收口（发新回合即清掉该话题上一回合的登记）。 */
export const addAbortController = (id: string, abortFn: () => void, topicId?: string) => {
  if (topicId !== undefined) {
    const previousId = abortKeysByTopic.get(topicId)
    if (previousId !== undefined && previousId !== id) {
      abortMap.delete(previousId)
    }
    abortKeysByTopic.set(topicId, id)
  }
  abortMap.set(id, [...(abortMap.get(id) || []), abortFn])
}

export const removeAbortController = (id: string, abortFn?: () => void) => {
  const callbackArr = abortMap.get(id)
  if (abortFn && callbackArr) {
    const index = callbackArr.indexOf(abortFn)
    if (index !== -1) {
      callbackArr.splice(index, 1)
    }
    // r2-13：数组被摘空后必须删键，否则每条已结束的回合都在这里留一个空数组。
    if (callbackArr.length === 0) {
      abortMap.delete(id)
    }
  } else {
    abortMap.delete(id)
  }
  // 话题索引同步失效（避免用指向已删除键的陈旧登记去误删新回合）。
  for (const [topicId, key] of abortKeysByTopic) {
    if (key === id && !abortMap.has(key)) {
      abortKeysByTopic.delete(topicId)
    }
  }
}

/** 消息 id 改写（uuid → kernel-<topic>-<seq>）时迁移中止注册键，保证"停止"按钮仍能命中。 */
export const renameAbortController = (from: string, to: string) => {
  const fns = abortMap.get(from)
  if (fns?.length) {
    abortMap.set(to, [...(abortMap.get(to) || []), ...fns])
    abortMap.delete(from)
  }
}

/**
 * 回合结束（含错误/中断）时摘掉该话题当前登记的键。
 *
 * r2-13 的彻底版落点：`addAbortController` 只在**发新回合**时清上一回合的登记，于是空闲时
 * 每个见过的话题仍各留一个闭包。回合收尾时清一次，让表在空闲态归零。
 * 只在 `finishTurn` 调用——那里该话题的在途回合已经结束。
 */
export const clearAbortControllersForTopic = (topicId: string) => {
  const key = abortKeysByTopic.get(topicId)
  if (key !== undefined) removeAbortController(key)
}

export const abortCompletion = (id: string) => {
  const abortFns = abortMap.get(id)
  if (abortFns?.length) {
    for (const fn of [...abortFns]) {
      fn()
      removeAbortController(id, fn)
    }
  }
}

export function createAbortPromise<T>(signal: AbortSignal, finallyPromise: Promise<T>) {
  return new Promise<T>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Operation aborted', 'AbortError'))
      return
    }

    const abortHandler = (e: Event) => {
      logger.debug('abortHandler', e)
      reject(new DOMException('Operation aborted', 'AbortError'))
    }

    signal.addEventListener('abort', abortHandler, { once: true })

    void finallyPromise.finally(() => {
      signal.removeEventListener('abort', abortHandler)
    })
  })
}
