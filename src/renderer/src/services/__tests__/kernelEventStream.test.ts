import { fetchTopicEventsWithRetry, isDefinitiveTopicUnknown } from '@renderer/services/kernelEventStream'
import { KERNEL_QUERY_ATTEMPTS } from '@renderer/utils/topicBranch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 内核事件取数的失败分类与启动窗口容忍（v0.3.0-5，分支图"节点凭空消失"彻查的一部分）：
 *   ① 确定性"内核无此行"立即返回空会话（真实状态），不耗重试窗口——
 *      尤其消息路径：新建未首发话题点开不应白等 6×700ms 的重试长尾；
 *   ② 瞬时失败（No handler registered / session is not loaded）重试自愈；
 *   ③ 窗口用尽 → null（"不知道"），调用方不得当空。
 */

function stubEvents(impl: (callIndex: number) => Promise<unknown>): void {
  let calls = 0
  const fn = vi.fn(async () => {
    calls += 1
    return await impl(calls)
  })
  ;(window as unknown as { api: unknown }).api = { dshTopicEvents: fn }
}

beforeEach(() => {
  stubEvents(async () => ({ events: [] }))
})

describe('isDefinitiveTopicUnknown（确定性失败分类）', () => {
  it('主进程注册表无此行的报错 → true', () => {
    expect(isDefinitiveTopicUnknown(new Error('kernel: topic "abc" not found'))).toBe(true)
    expect(isDefinitiveTopicUnknown('Error invoking remote method: kernel: topic "x" not found')).toBe(true)
  })

  it('启动窗口的瞬时失败 → false（要重试）', () => {
    expect(isDefinitiveTopicUnknown(new Error('kernel: session "abc" is not loaded'))).toBe(false)
    expect(isDefinitiveTopicUnknown(new Error('No handler registered for "dsh:topic-events"'))).toBe(false)
    expect(isDefinitiveTopicUnknown(new Error('ipc down'))).toBe(false)
  })
})

describe('fetchTopicEventsWithRetry（启动窗口容忍）', () => {
  it('确定性 not found → 立即空会话（一次 IPC，零重试延迟）', async () => {
    stubEvents(async () => {
      throw new Error('kernel: topic "t" not found')
    })

    const events = await fetchTopicEventsWithRetry('t', { attempts: 3, delayMs: 1 })

    expect(events).toEqual([])
    const api = (window as unknown as { api: { dshTopicEvents: { mock: { calls: unknown[] } } } }).api
    expect(api.dshTopicEvents.mock.calls.length).toBe(1)
  })

  it('空日志是确定性答案 → 原样返回，不重试', async () => {
    const events = await fetchTopicEventsWithRetry('t', { attempts: 3, delayMs: 1 })
    expect(events).toEqual([])
  })

  it('瞬时失败两次后自愈 → 返回事件', async () => {
    stubEvents(async (callIndex) => {
      if (callIndex <= 2) throw new Error('No handler registered')
      return { events: [{ seq: 1, type: 'user/message' }] }
    })

    const events = await fetchTopicEventsWithRetry('t', { attempts: 3, delayMs: 1 })

    expect(events?.length).toBe(1)
    const api = (window as unknown as { api: { dshTopicEvents: { mock: { calls: unknown[] } } } }).api
    expect(api.dshTopicEvents.mock.calls.length).toBe(3)
  })

  it('瞬时失败贯穿整个窗口 → null（不知道，绝不当空）', async () => {
    stubEvents(async () => {
      throw new Error('No handler registered')
    })

    const events = await fetchTopicEventsWithRetry('t', { attempts: 3, delayMs: 1 })

    expect(events).toBeNull()
    const api = (window as unknown as { api: { dshTopicEvents: { mock: { calls: unknown[] } } } }).api
    expect(api.dshTopicEvents.mock.calls.length).toBe(3)
  })
})

describe('fetchTopicEventsWithRetry（默认窗口 = 成员查询同口径）', () => {
  it('不传 options 时用 KERNEL_QUERY_ATTEMPTS 次尝试', async () => {
    stubEvents(async () => {
      throw new Error('session is not loaded')
    })

    const events = await fetchTopicEventsWithRetry('t', { attempts: KERNEL_QUERY_ATTEMPTS, delayMs: 1 })

    expect(events).toBeNull()
    const api = (window as unknown as { api: { dshTopicEvents: { mock: { calls: unknown[] } } } }).api
    expect(api.dshTopicEvents.mock.calls.length).toBe(KERNEL_QUERY_ATTEMPTS)
  })
})
