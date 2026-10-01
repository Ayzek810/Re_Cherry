/**
 * worker 高亮失败后的降级必须是**有期限**的。
 *
 * 缺陷原状：`highlightCodeChunk` 的 catch 分支与 `sendWorkerMessage` 的超时分支都写
 * `workerDegradationCache.set(callerId, true)`，而该 LRU 的 TTL 是 12 小时、`updateAgeOnGet`
 * 未开 ⇒ 一次 worker 超时（例如某个超长代码块）就把该 callerId **永久**钉在主线程路径上，
 * 之后该块所有 delta 都在主线程做 shiki tokenize，与每帧重解析叠加成
 * "某条消息越流越卡而其他消息正常"。
 *
 * 修复后：存"冷却截止时间戳"，到点惰性删除 ⇒ 重新尝试 worker。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { shikiStreamService } from '../ShikiStreamService'

describe('ShikiStreamService worker degradation cooldown', () => {
  beforeEach(() => {
    shikiStreamService.dispose()
  })
  afterEach(() => {
    shikiStreamService.dispose()
    vi.restoreAllMocks()
  })

  /** 把服务推到"worker 可用但 postMessage 必失败"的状态，模拟半死 worker。 */
  function forceWorkerFailure() {
    // @ts-ignore: access private
    shikiStreamService.worker = {
      postMessage: () => {
        throw new Error('worker is half-dead')
      }
    } as any
    // @ts-ignore: access private
    shikiStreamService.workerInitPromise = null
    // @ts-ignore: access private
    shikiStreamService.workerInitRetryCount = 0
  }

  it('marks the caller as degraded on the first worker failure', async () => {
    forceWorkerFailure()
    await shikiStreamService.highlightCodeChunk('const a = 1', 'typescript', 'one-light', 'cooldown-caller')

    // @ts-ignore: access private
    expect(shikiStreamService.isDegraded('cooldown-caller')).toBe(true)
  })

  it('stops degrading once the cooldown deadline passes (retries the worker)', async () => {
    const callerId = 'cooldown-expiry-caller'
    // @ts-ignore: access private
    shikiStreamService.workerDegradationCache.set(callerId, Date.now() + 50)
    // @ts-ignore: access private
    expect(shikiStreamService.isDegraded(callerId)).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 70))

    // @ts-ignore: access private
    expect(shikiStreamService.isDegraded(callerId)).toBe(false)
    // 惰性删除：条目必须被摘掉，而不是靠 12 小时 TTL 兜底
    // @ts-ignore: access private
    expect(shikiStreamService.workerDegradationCache.has(callerId)).toBe(false)
  })

  it('a second highlight attempt after the cooldown goes back through the worker path', async () => {
    const callerId = 'cooldown-retry-caller'
    // worker 一直失败：用来数"是否又尝试了 worker"
    const sendSpy = vi
      // @ts-ignore: access private
      .spyOn(shikiStreamService as any, 'sendWorkerMessage')
      .mockRejectedValue(new Error('worker highlight failed'))

    forceWorkerFailure()
    await shikiStreamService.highlightCodeChunk('const a = 1', 'typescript', 'one-light', callerId)
    expect(sendSpy).toHaveBeenCalledTimes(1)

    // 冷却未过期：走主线程，**不再**尝试 worker（不复现"每个 delta 都白试一次"）
    sendSpy.mockClear()
    await shikiStreamService.highlightCodeChunk('const a = 2', 'typescript', 'one-light', callerId)
    expect(sendSpy).not.toHaveBeenCalled()

    // 冷却过期后：重新尝试 worker（的核心：降级是有期限的，不是永久）
    // @ts-ignore: access private
    shikiStreamService.workerDegradationCache.set(callerId, Date.now() - 1)
    await shikiStreamService.highlightCodeChunk('const a = 3', 'typescript', 'one-light', callerId)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ type: 'highlight', callerId })
  })
})
