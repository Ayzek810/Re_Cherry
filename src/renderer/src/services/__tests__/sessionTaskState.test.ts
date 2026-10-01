/**
 * sessionTaskState（任务面板投影）的重放契约与有界性。
 *
 * 三条不变量在这里被钉住：
 * - ：重放失败（`null` = 重试窗口耗尽"不知道" / reject）不得把话题标记成"已重放"，
 *   否则该话题的历史 todo/goal 在整个进程生命周期内都不会再折叠；重试限次（REPLAY_MAX_ATTEMPTS）。
 * - ：重放回调落地时若直播已推进过状态版本，丢弃重放整值——不让旧快照覆盖较新状态。
 * - ：`states` 有 LRU 上限；空快照且最后一位订阅者退订时释放条目。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type KernelSessionEventPayload = { topicId: string; event: SessionEvent }

const fetchTopicEventsWithRetry = vi.fn<(topicId: string) => Promise<SessionEvent[] | null>>()
let liveCallback: ((payload: KernelSessionEventPayload) => void) | null = null
/** 取证钩子（重放竞态丢弃）的替身：用它判定"重放回调确实跑完了"。 */
const forensicWarn = vi.fn()

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      warn: (...args: unknown[]) => forensicWarn(...args),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('../kernelEventStream', () => ({
  fetchTopicEventsWithRetry: (topicId: string) => fetchTopicEventsWithRetry(topicId),
  subscribeKernelSessionEvents: (callback: (payload: KernelSessionEventPayload) => void) => {
    liveCallback = callback
    return () => {
      liveCallback = null
    }
  }
}))

function todoEvent(text: string): SessionEvent {
  return { type: 'todo/write', data: { todos: [{ content: text, status: 'pending' }] } } as unknown as SessionEvent
}

function goalEvent(id: string): SessionEvent {
  return {
    type: 'goal/change',
    data: { operation: 'set', goal: { id, phase: 'active' }, roundsStarted: 1 }
  } as unknown as SessionEvent
}

function emitLive(topicId: string, event: SessionEvent): void {
  if (liveCallback === null) throw new Error('live subscription is not bound yet')
  liveCallback({ topicId, event })
}

/**
 * 让"重放 promise 链的 `.then`"跑完。链上有若干个 await（`retryKernelQuery` 的循环），
 * 微任务批次不确定，因此用一次真实宏任务作为稳定边界（本套件已实证 setTimeout 会触发）。
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

/** 每次取新模块：`states`/`replayAttempts`/`liveBound` 都是模块内状态。 */
async function loadModule() {
  vi.resetModules()
  return await import('../sessionTaskState')
}

beforeEach(() => {
  fetchTopicEventsWithRetry.mockReset()
  forensicWarn.mockReset()
  liveCallback = null
})

describe('sessionTaskState · 重放失败不得留下"已重放"标记', () => {
  it('`null`（重试窗口耗尽 = 不知道）后再次 ensure 会重新拉取，成功即折叠历史', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot, isTopicTaskReplayComplete } = await loadModule()
    fetchTopicEventsWithRetry.mockResolvedValueOnce(null).mockResolvedValueOnce([todoEvent('历史任务')])

    ensureTopicTasks('t1')
    await settle()
    // 第一次"不知道"：不得当作已重放——此时还没有任何投影，且没有"已完成"记号
    expect(isTopicTaskReplayComplete('t1')).toBe(false)
    expect(getTopicTaskSnapshot('t1').todos).toBeNull()

    ensureTopicTasks('t1')
    await settle()
    expect(getTopicTaskSnapshot('t1').todos?.[0]).toMatchObject({ content: '历史任务' })
    expect(isTopicTaskReplayComplete('t1')).toBe(true)
  })

  it('reject 同样不留下标记：下一次 ensure 会重试成功后折叠历史', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot, isTopicTaskReplayComplete } = await loadModule()
    fetchTopicEventsWithRetry
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce([todoEvent('重试成功')])

    ensureTopicTasks('t1')
    await settle()
    expect(isTopicTaskReplayComplete('t1')).toBe(false)

    ensureTopicTasks('t1')
    await settle()
    expect(getTopicTaskSnapshot('t1').todos?.[0]).toMatchObject({ content: '重试成功' })
  })

  it('重放尝试限次（REPLAY_MAX_ATTEMPTS）：不可达话题在限次后不再重拉', async () => {
    const max = (await import('../sessionTaskState')).REPLAY_MAX_ATTEMPTS
    const { ensureTopicTasks, getTopicTaskReplayAttempts, isTopicTaskReplayComplete } = await loadModule()
    fetchTopicEventsWithRetry.mockResolvedValue(null)

    for (let i = 1; i <= max; i += 1) {
      ensureTopicTasks('t1')
      await settle()
      expect(fetchTopicEventsWithRetry).toHaveBeenCalledTimes(i)
    }
    // 失败永远是"不知道"：记号仍未完成，但尝试计数已到上限
    expect(isTopicTaskReplayComplete('t1')).toBe(false)
    expect(getTopicTaskReplayAttempts('t1')).toBe(max)
    // 第 max+1 次起不再发请求（否则"不可达"话题会被无上限重拉）
    ensureTopicTasks('t1')
    ensureTopicTasks('t1')
    await settle()
    expect(fetchTopicEventsWithRetry).toHaveBeenCalledTimes(max)
  })

  it('成功重放后保留"已重放"记号：后续 ensure 不再拉取', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot, isTopicTaskReplayComplete } = await loadModule()
    fetchTopicEventsWithRetry.mockResolvedValue([todoEvent('只拉一次')])

    ensureTopicTasks('t1')
    await settle()
    expect(getTopicTaskSnapshot('t1').todos).toHaveLength(1)
    expect(isTopicTaskReplayComplete('t1')).toBe(true)

    ensureTopicTasks('t1')
    await settle()
    expect(fetchTopicEventsWithRetry).toHaveBeenCalledTimes(1)
  })
})

describe('sessionTaskState · 重放不得覆盖较新的直播状态', () => {
  it('直播事件在重放落地前推进 → 丢弃重放整值，保留直播的新状态', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot } = await loadModule()
    let resolveReplay: (value: SessionEvent[] | null) => void = () => {}
    fetchTopicEventsWithRetry.mockImplementationOnce(
      () => new Promise<SessionEvent[] | null>((resolve) => (resolveReplay = resolve))
    )

    ensureTopicTasks('t1')
    await vi.waitFor(() => expect(liveCallback).not.toBeNull())

    // 直播先进（聚合值"直播较新"、goal 已被 clear → 无 goal）：状态版本推进
    emitLive('t1', todoEvent('直播较新'))
    emitLive('t1', { type: 'goal/change', data: { operation: 'clear' } } as unknown as SessionEvent)
    expect(getTopicTaskSnapshot('t1').todos?.[0]).toMatchObject({ content: '直播较新' })

    // 重放随后落地，携带的是**更旧**的历史快照（旧 todo + 直播已清掉的 goal）
    resolveReplay([todoEvent('历史较旧'), goalEvent('goal-stale')])
    await settle()

    const snapshot = getTopicTaskSnapshot('t1')
    expect(snapshot.todos?.[0]).toMatchObject({ content: '直播较新' })
    // 重放整值被丢弃 → 直播已清掉的 goal 不得被旧快照写回
    expect(snapshot.goal).toBeNull()
    // 取证钩子确实记了这次丢弃（的可观测信号）
    expect(forensicWarn.mock.calls.some((call) => String(call[0]).includes('replay result dropped'))).toBe(true)
  })

  it('重放期间无直播推进 → 正常折叠历史（对照）', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot } = await loadModule()
    let resolveReplay: (value: SessionEvent[] | null) => void = () => {}
    fetchTopicEventsWithRetry.mockImplementationOnce(
      () => new Promise<SessionEvent[] | null>((resolve) => (resolveReplay = resolve))
    )

    ensureTopicTasks('t1')
    await vi.waitFor(() => expect(liveCallback).not.toBeNull())
    resolveReplay([todoEvent('历史'), goalEvent('goal-1')])
    await vi.waitFor(() => expect(getTopicTaskSnapshot('t1').todos).toHaveLength(1))
    expect(getTopicTaskSnapshot('t1').goal).toMatchObject({ id: 'goal-1' })
  })
})

describe('sessionTaskState · 投影缓存有界', () => {
  it('states 有 LRU 上限：写满上限后条目数不再增长，且最近写入的话题仍可读', async () => {
    const { STATES_MAX, ensureTopicTasks, getTopicTaskSnapshot, getTopicTaskStateCount } = await loadModule()
    fetchTopicEventsWithRetry.mockResolvedValue(null)
    for (let i = 0; i < STATES_MAX + 25; i += 1) {
      const topicId = `topic-${i}`
      ensureTopicTasks(topicId)
      emitLive(topicId, todoEvent(`任务-${topicId}`))
    }

    expect(getTopicTaskStateCount()).toBe(STATES_MAX)
    // 最近写入的条目仍是**原值**（LRU 淘汰不得把活话题的状态换成别的）
    expect(getTopicTaskSnapshot(`topic-${STATES_MAX + 24}`).todos?.[0]).toMatchObject({
      content: `任务-topic-${STATES_MAX + 24}`
    })
    // 淘汰的是最久未写入的条目 → 读回 EMPTY（投影语义：可重新折叠，不残留错误值）
    expect(getTopicTaskSnapshot('topic-0').todos).toBeNull()
  })

  it('空快照 + 最后一位订阅者退订 → 释放条目，不影响其它话题', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot, getTopicTaskStateCount, subscribeTopicTasks } = await loadModule()
    // 'empty-topic' 的重放返回 `[]`（确定性"从未写过 todo"）→ 写入一个 EMPTY 快照条目
    fetchTopicEventsWithRetry.mockResolvedValue([])
    const unsubscribe = subscribeTopicTasks('empty-topic', () => {})
    ensureTopicTasks('empty-topic')
    await settle()
    // 'live-topic' 直播写入一条 todo（非空快照）
    ensureTopicTasks('live-topic')
    emitLive('live-topic', todoEvent('保留'))

    expect(getTopicTaskStateCount()).toBe(2)
    expect(getTopicTaskSnapshot('empty-topic')).toMatchObject({ todos: null, goal: null })

    unsubscribe()
    // 空快照且无人订阅 → 条目释放；非空话题保留
    expect(getTopicTaskStateCount()).toBe(1)
    // 投影语义不变（无条目 == EMPTY）
    expect(getTopicTaskSnapshot('empty-topic').todos).toBeNull()
    expect(getTopicTaskSnapshot('live-topic').todos).toHaveLength(1)
  })

  it('每次 replace 都推进版本号（重放竞态判据的基础）', async () => {
    const { ensureTopicTasks, getTopicTaskSnapshot } = await loadModule()
    fetchTopicEventsWithRetry.mockResolvedValue(null)
    ensureTopicTasks('t1')
    const first = getTopicTaskSnapshot('t1')
    emitLive('t1', todoEvent('a'))
    const second = getTopicTaskSnapshot('t1')
    emitLive('t1', todoEvent('b'))
    const third = getTopicTaskSnapshot('t1')
    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
    expect(third.todos?.[0]).toMatchObject({ content: 'b' })
  })
})
