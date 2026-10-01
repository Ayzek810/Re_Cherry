/**
 * 工具快照读路径的 stale-while-revalidate 语义。
 *
 * 设计意图是「有缓存即秒回旧状态，后台重探完成后 broadcastChanged 刷新」。但判定顺序此前是
 * 「后台重探在飞 ⇒ await 它再返回」，于是**恰好在最该秒回的窗口**（重探进行中，时长可达
 * `--version` 探针超时级）读路径反而挂起；同一时刻多个渲染层请求一起悬着。
 *
 * 本文件直接操纵 `snapshotCache` / `snapshotProbeInFlight` 两个内部事实，断言读路径的选择：
 * 有缓存 → 立即作答（不等重探）；完全无缓存 → 才 await 首次探针。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { binaryManager } from '../BinaryManager'

type Snapshot = Record<string, unknown>

const CACHED: Snapshot = { dsh: { name: 'dsh', application: 'absent', availability: { source: 'none' } } }

type Internals = {
  snapshotCache: { data: Snapshot; at: number } | null
  snapshotProbeInFlight: Promise<void> | null
  startBackgroundSnapshotRefresh: () => void
  readSnapshotCacheFile: () => Promise<Snapshot | null>
  getToolSnapshots: (names: readonly string[]) => Promise<Snapshot>
}

const internals = binaryManager as unknown as Internals

/** 让后台重探变成可控的挂起 Promise，并记录启动次数。 */
function installPendingRefresh(): { state: { started: number }; release: () => void } {
  const state = { started: 0 }
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  internals.startBackgroundSnapshotRefresh = () => {
    state.started++
    internals.snapshotProbeInFlight = pending
  }
  return {
    state,
    release: () => {
      internals.snapshotProbeInFlight = null
      release()
    }
  }
}

describe('BinaryManager 快照读路径', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    internals.snapshotCache = null
    internals.snapshotProbeInFlight = null
  })

  it('有缓存且新鲜：立即返回缓存，不启动重探', async () => {
    internals.snapshotCache = { data: CACHED, at: Date.now() }
    const refresh = installPendingRefresh()

    await expect(internals.getToolSnapshots(['dsh'])).resolves.toBe(CACHED)
    expect(refresh.state.started).toBe(0)
  })

  it('有缓存但过期：立即返回缓存（不等重探），只启动一次后台重探', async () => {
    internals.snapshotCache = { data: CACHED, at: Date.now() - 60_000 }
    const refresh = installPendingRefresh()

    await expect(internals.getToolSnapshots(['dsh'])).resolves.toBe(CACHED)
    expect(refresh.state.started).toBe(1)
    expect(internals.snapshotProbeInFlight).not.toBeNull()
    refresh.release()
  })

  it('重探进行中 + 有缓存：立即返回缓存（不在最该秒回的窗口挂起）', async () => {
    internals.snapshotCache = { data: CACHED, at: Date.now() - 60_000 }
    let resolveProbe: () => void = () => {}
    internals.snapshotProbeInFlight = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })

    // 旧实现此处会 await 这个永不 resolve 的 probe（测试会超时）。
    const result = await Promise.race([
      internals.getToolSnapshots(['dsh']),
      new Promise((resolve) => setTimeout(() => resolve('TIMED_OUT'), 300))
    ])
    expect(result).toBe(CACHED)

    resolveProbe()
  })

  it('完全无缓存：await 首次探针并以探针结果为准', async () => {
    internals.readSnapshotCacheFile = async () => null
    let resolveProbe: () => void = () => {}
    internals.snapshotProbeInFlight = new Promise<void>((resolve) => {
      resolveProbe = () => {
        internals.snapshotCache = { data: CACHED, at: Date.now() }
        resolve()
      }
    })

    const pending = internals.getToolSnapshots(['dsh'])
    resolveProbe()
    await expect(pending).resolves.toBe(CACHED)
  })
})
