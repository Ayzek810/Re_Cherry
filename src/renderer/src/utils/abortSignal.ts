import { loggerService } from '@logger'

const logger = loggerService.withContext('AbortSignal')

/**
 * 把一个 `AbortSignal` 变成"中止即拒绝"的 Promise，用于与另一条 Promise 赛跑
 * （`Promise.race([createAbortPromise(signal, p), p])`），让不支持 signal 的异步工作也能被取消。
 *
 * 归属说明（2026-10-01）：本函数原先住在 `utils/abortController.ts`——那个文件同时装着渲染层的
 * 「暂停中止登记表」。本次暂停重做按话题记账、登记表整体删除，但这个与暂停无关的通用小工具被
 * `utils/fetch.ts` 使用，故单独迁到本文件保留（原语义逐字不变）。
 */
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
