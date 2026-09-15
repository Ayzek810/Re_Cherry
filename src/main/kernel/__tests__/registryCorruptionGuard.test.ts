import { rm, writeFile } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createTempUserData,
  listCorruptBackups,
  readCorruptBackupBytes,
  readRegistryBytes,
  readSessionCounts,
  registryFile,
  seedKernelState
} from './helpers/seedKernelState'

/**
 * v0.3.0-4 问题 D：**损坏注册表不得导致启动清扫物理删库**（验D-1 ~ 验D-5）。
 *
 * 故障链：`topics.json` 损坏 → `loadRegistry` 的 catch 把"读不出来"折叠成"空注册表" →
 * `sweepOrphanSessions` 取 `known = ∅` → 库里每个会话都被判孤儿 → `DELETE FROM events/sessions`。
 * 一次解析失败 = 一次启动 = 全部会话日志消失。
 *
 * 覆盖的边界是"**真实文件 + 真实 SQLite + 真实清扫**"：临时 userData 目录、真实 `topics.json`、
 * 真实 `sessions.db`（`node:sqlite`），清扫走 `purgePersistedSession` 本体（不注入 sessionGC），
 * 因此"库里还剩什么"就是最强证据。
 *
 * 两点环境事实：
 * - `tests/main.setup.ts` 全局 mock 了 `node:fs` / `node:os` / `node:path` 与 `app.getPath`，
 *   本文件要碰真实文件系统，故先 unmock，再把 `app.getPath('userData')` 指向临时目录。
 * - 生产路径调用 `loadRegistry()`（不带参数，走 `app.getPath`）。测试统一先 `loadRegistry(dir)`
 *   把接缝指向临时目录，再走 `initTopics`。
 */
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

const { initTopics, loadRegistry, shouldSweepOrphans } = await import('../topics')

let dir = ''
let loggerError: ReturnType<typeof vi.spyOn>

/** 只提供清扫真正用到的东西：会话列表（枚举）+ 可选的 sessionGC（缺失时走真实物理删除）。 */
function makeCtx(ids: string[], purge?: (id: string) => Promise<void>): Context {
  return {
    sessionPersistence: { list: async () => ids.map((id) => ({ id })) },
    ...(purge === undefined ? {} : { sessionGC: { purge } }),
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

describe('损坏注册表守卫（问题 D）', () => {
  it('验D-1：注册表**缺失**（absent）+ 库里有会话 → 仍然清扫（既有孤儿语义不回归）', async () => {
    await seedKernelState({ dir, registry: 'absent', sessions: [{ id: 'sess-a', events: 3 }, { id: 'sess-b' }] })
    expect(await readSessionCounts(dir)).toEqual({ sessions: 2, events: 4 })
    await loadRegistry(dir)

    await initTopics(makeCtx(['sess-a', 'sess-b']))

    expect(await readSessionCounts(dir)).toEqual({ sessions: 0, events: 0 })
  })

  it('验D-2：注册表**读不出来**（failed）→ purge 次数为 0，且记 logger.error', async () => {
    await seedKernelState({ dir, registry: 'corrupt', sessions: [{ id: 'sess-a', events: 3 }, { id: 'sess-b' }] })
    const purge = vi.fn(async () => {})
    await loadRegistry(dir)

    await initTopics(makeCtx(['sess-a', 'sess-b'], purge))

    expect(purge).not.toHaveBeenCalled()
    // 计数断言（不用耗时类信号）：库原封不动
    expect(await readSessionCounts(dir)).toEqual({ sessions: 2, events: 4 })
    const messages = loggerError.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('orphan sweep skipped'))).toBe(true)
    expect(messages.some((message) => message.includes('could not be read'))).toBe(true)
  })

  it('验D-3：注册表**解析成功**且有孤儿 → 仍然清扫，且只清孤儿（真实功能不受损）', async () => {
    await seedKernelState({
      dir,
      registry: { topics: [{ id: 'sess-a', name: 'A', createdAt: 1, updatedAt: 2, provider: 'p', model: 'm' }] },
      sessions: [
        { id: 'sess-a', events: 2 },
        { id: 'sess-b', events: 3 }
      ]
    })
    await loadRegistry(dir)

    await initTopics(makeCtx(['sess-a', 'sess-b']))

    const counts = await readSessionCounts(dir)
    expect(counts.sessions).toBe(1)
    expect(counts.events).toBe(2) // A 的 2 条事件仍在，B 的 3 条被清
  })

  it('验D-4：读不出来时**原文件字节不变**，且在任何覆盖之前已生成 `.corrupt-*` 备份（内容逐字节相同）', async () => {
    await seedKernelState({ dir, registry: 'corrupt', sessions: [{ id: 'sess-a' }] })
    const before = await readRegistryBytes(dir)

    expect(await loadRegistry(dir)).toBe('failed')

    expect(await readRegistryBytes(dir)).toEqual(before) // 未覆盖、未搬走
    const backups = await listCorruptBackups(dir)
    expect(backups).toHaveLength(1)
    expect(await readCorruptBackupBytes(dir, backups[0])).toEqual(before)
  })

  it('验D-4 补：内容相同的第二次加载不再堆备份（每批损坏内容只留一份）', async () => {
    await seedKernelState({ dir, registry: 'corrupt' })

    expect(await loadRegistry(dir)).toBe('failed')
    expect(await loadRegistry(dir)).toBe('failed')

    expect(await listCorruptBackups(dir)).toHaveLength(1)
  })

  it('验D-5：三态 × 行数的判定穷举（纯函数）', () => {
    expect(shouldSweepOrphans('failed', 0).sweep).toBe(false)
    expect(shouldSweepOrphans('failed', 3).sweep).toBe(false)
    expect(shouldSweepOrphans('absent', 0).sweep).toBe(true)
    expect(shouldSweepOrphans('absent', 3).sweep).toBe(true)
    expect(shouldSweepOrphans('loaded', 0).sweep).toBe(true)
    expect(shouldSweepOrphans('loaded', 3).sweep).toBe(true)

    // reason 要能区分状态，不是恒等返回
    const reasons = new Set([
      shouldSweepOrphans('failed', 0).reason,
      shouldSweepOrphans('absent', 0).reason,
      shouldSweepOrphans('absent', 3).reason,
      shouldSweepOrphans('loaded', 3).reason
    ])
    expect(reasons.size).toBe(4)
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(20)
  })

  it('结构补：注册表能解析但没有 topics 数组（手改成 {}）→ 同样按"读不出来"处理，不清扫', async () => {
    // 这是"能解析的坏文件"：若按 loaded/0 行处理，清扫照样删库
    await seedKernelState({ dir, sessions: [{ id: 'sess-a' }] })
    await writeFile(registryFile(dir), '{}', 'utf8')
    const purge = vi.fn(async () => {})
    expect(await loadRegistry(dir)).toBe('failed')

    await initTopics(makeCtx(['sess-a'], purge))

    expect(purge).not.toHaveBeenCalled()
    expect(await readSessionCounts(dir)).toEqual({ sessions: 1, events: 1 })
    expect(await listCorruptBackups(dir)).toHaveLength(1)
  })
})
