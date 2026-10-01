import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const endTrace = vi.fn()
vi.mock('@renderer/services/SpanManagerService', () => ({
  endTrace: (...args: unknown[]) => endTrace(...args)
}))

import { disposeTopicQueue, getTopicQueue, hasTopicPendingRequests, waitForTopicQueue } from '../queue'

/** 让 p-queue 的微任务链跑完（等待队列进入 idle）。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('utils/queue（audit2 r2-97）', () => {
  describe('scheduling behaviour（真实定时器；用 scheduleEviction 的 5 分钟延时保证不触发）', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('returns the same instance for the same topicId', () => {
      const first = getTopicQueue('topic-a')
      const second = getTopicQueue('topic-a')
      expect(second).toBe(first)
    })

    it('ends the trace once per queue lifetime, not on every idle transition', async () => {
      const queue = getTopicQueue('topic-trace')

      await queue.add(() => Promise.resolve(1))
      await settle()
      expect(endTrace).toHaveBeenCalledTimes(1)

      // 第二轮任务：再次变空 → 仍然只允许一次 endTrace
      // （p-queue 的 idle 在每次队列变空时都触发，原实现会重复 endTrace）
      await queue.add(() => Promise.resolve(2))
      await settle()
      expect(endTrace).toHaveBeenCalledTimes(1)
      expect(endTrace).toHaveBeenCalledWith({ topicId: 'topic-trace' })
    })

    it('still runs tasks and reports pending state', async () => {
      const queue = getTopicQueue('topic-sched', { concurrency: 1 })
      let completed = 0
      const running = queue.add(async () => {
        await Promise.resolve()
        completed += 1
      })
      expect(hasTopicPendingRequests('topic-sched')).toBe(true)
      await running
      await settle()
      expect(completed).toBe(1)
      expect(hasTopicPendingRequests('topic-sched')).toBe(false)
    })

    it('waitForTopicQueue still resolves via onIdle for the live queue', async () => {
      const queue = getTopicQueue('topic-wait')
      void queue.add(() => Promise.resolve(1))
      await expect(waitForTopicQueue('topic-wait')).resolves.toBeUndefined()
    })

    it('disposeTopicQueue drops the queue and allows a fresh one', () => {
      const queue = getTopicQueue('topic-dispose')
      expect(disposeTopicQueue('topic-dispose')).toBe(true)
      expect(disposeTopicQueue('topic-dispose')).toBe(false)
      expect(getTopicQueue('topic-dispose')).not.toBe(queue)
    })
  })

  describe('eviction（假定时器）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.clearAllMocks()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('evicts the queue after the idle grace period', async () => {
      const queue = getTopicQueue('topic-evict')
      const running = queue.add(() => Promise.resolve(1))
      await running
      await queue.onIdle()

      // 5 分钟宽限期内的任意时刻仍是同一个实例（waitForTopicQueue 依赖这一点）
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      expect(getTopicQueue('topic-evict')).toBe(queue)

      // 宽限期过后被回收：再取就是一个新实例
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
      expect(getTopicQueue('topic-evict')).not.toBe(queue)
    })

    it('does not evict a queue that has pending work again', async () => {
      const queue = getTopicQueue('topic-busy')
      let release: (() => void) | undefined
      void queue.add(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      // 任务未完成 → 不回收
      expect(getTopicQueue('topic-busy')).toBe(queue)

      release?.()
      await vi.runAllTimersAsync()
    })
  })
})
