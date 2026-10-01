import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'
import { app } from 'electron'
vi.mock('@main/services/SearchService', () => ({
  searchService: new Proxy({}, { get: () => vi.fn() }),
  SearchService: class {}
}))
vi.mock('@main/services/webSearchProviders/webFetch', () => ({ fetchWebContent: vi.fn(async () => ({ content: '' })) }))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTempUserData, readSessionCounts, seedKernelState } from './helpers/seedKernelState'

/**
 * k2-05 / k2-09：**清盘失败必须可被调用方感知**，且清理动作本身要带内核连接的两条契约
 * （`busy_timeout` + 单事务）。
 *
 * 旧行为（二轮审查记录）：`purgePersistedSession` 返回 `void`，内部 `catch` 只记 warn；
 * `purgeViaSessionGC` 再把上一步的异常吞一次。于是"注册表行已删、磁盘数据还在"被 UI
 * 呈现为完全成功，且清扫的 `removed += 1` 把失败也数成"已清除"。
 *
 * 本文件钉住的契约：
 *   1. `purgePersistedSession` 返回 `boolean`（真删成功 = true；失败 = false 且记 error）。
 *   2. 会话不存在不是失败（幂等删除 = true）。
 *   3. 接入的 `ctx.sessionGC.purge` 返回 `false` 时，清扫**如实记 error** 且不再谎报已清除
 *      ——磁盘上的会话数据仍在（用真实 SQLite 行数作证据）。
 */
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

const { initTopics, loadRegistry, purgePersistedSession } = await import('../topics')

let dir = ''
let loggerError: ReturnType<typeof vi.spyOn>

function makeCtx(ids: string[], purge: (id: string) => Promise<boolean>): Context {
  return {
    sessionPersistence: { list: async () => ids.map((id) => ({ id })) },
    sessionGC: { purge },
    on: vi.fn()
  } as unknown as Context
}

beforeEach(async () => {
  dir = await createTempUserData()
  vi.mocked(app.getPath).mockImplementation((key: string) => (key === 'userData' ? dir : `/mock/${key}`))
  loggerError = vi.spyOn(loggerService, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  loggerError.mockRestore()
  if (dir.length > 0) await rm(dir, { recursive: true, force: true })
})

describe('purgePersistedSession 的真实返回值（k2-05/k2-09）', () => {
  it('真删成功 → true，且两张表的行都没了', async () => {
    await seedKernelState({ dir, registry: { topics: [] }, sessions: [{ id: 'sess-a', events: 3 }] })
    expect(await readSessionCounts(dir)).toEqual({ sessions: 1, events: 3 })

    expect(await purgePersistedSession('sess-a')).toBe(true)

    expect(await readSessionCounts(dir)).toEqual({ sessions: 0, events: 0 })
  })

  it('会话不存在 → 仍是 true（幂等删除不是失败）', async () => {
    await seedKernelState({ dir, registry: { topics: [] } })
    expect(await purgePersistedSession('never-existed')).toBe(true)
  })

  it('库不可用（sessions.db 被同名目录占住）→ false 并记 error，不静默', async () => {
    await seedKernelState({ dir, registry: { topics: [] } })
    // 存在但打不开：把 sessions.db 换成同名目录（DatabaseSync 必然失败）。
    const dbPath = join(dir, 'kernel', 'sessions.db')
    await mkdir(dbPath, { recursive: true })

    expect(await purgePersistedSession('sess-a')).toBe(false)
    const messages = loggerError.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('session data is still on disk'))).toBe(true)
  })
})

describe('清扫消费清盘结果：失败不得谎报为已清除（k2-09）', () => {
  it('ctx.sessionGC.purge 回 false → 记 error，且磁盘上的会话数据仍在', async () => {
    await seedKernelState({ dir, registry: { topics: [] }, sessions: [{ id: 'orphan-a', events: 2 }] })
    expect(await loadRegistry(dir)).toBe('loaded')
    // 接管方"声称"清盘失败：真实数据留在盘上（这是最坏情形——注册表没了、文件还在）。
    const purge = vi.fn(async () => false)

    await initTopics(makeCtx(['orphan-a'], purge))

    expect(purge).toHaveBeenCalledWith('orphan-a')
    expect(await readSessionCounts(dir)).toEqual({ sessions: 1, events: 2 })
    const messages = loggerError.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('1 orphan persisted session(s) could not be purged'))).toBe(true)
  })

  it('接管方抛错 → 回退默认实现（真删），结果仍为已清除', async () => {
    await seedKernelState({ dir, registry: { topics: [] }, sessions: [{ id: 'orphan-a', events: 2 }] })
    expect(await loadRegistry(dir)).toBe('loaded')
    const purge = vi.fn(async () => {
      throw new Error('plugin purge exploded')
    })

    await initTopics(makeCtx(['orphan-a'], purge))

    // 回退真的删掉了：文件里没有残行，也没有"没清掉"的 error 计数
    expect(await readSessionCounts(dir)).toEqual({ sessions: 0, events: 0 })
    const messages = loggerError.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('could not be purged'))).toBe(false)
  })
})
