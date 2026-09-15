import { rm } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTempUserData, readRegistryTopicIds, readSessionIds, seedKernelState } from './helpers/seedKernelState'

/**
 * v0.3.0-4 的 **M 项**：`report.md` §4.2 里标"机测替代"的三条（M2' / M4' / M5'）。
 *
 * 为什么能机测替代：这三条要验的是**内核读文件 / 读库之后的行为**，不需要 Electron 渲染进程——
 * 只需要能自己造出那个状态（见 `helpers/seedKernelState.ts`）。M1'（点击链路 + 真内核）与真机启动
 * 时序**不在本文件覆盖范围**，按报告留给 v0.3.1。
 *
 * 环境事实同 `registryCorruptionGuard.test.ts`：unmock 真实 fs/os/path，并把 `app.getPath('userData')`
 * 指向临时目录；生产路径不带参数，测试统一先 `loadRegistry(dir)` 把接缝指过去。
 */
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

const { deleteTopic, initTopics, loadRegistry } = await import('../topics')

let dir = ''

function makeCtx(ids: string[]): Context {
  return {
    sessionPersistence: { list: async () => ids.map((id) => ({ id })) },
    on: vi.fn()
  } as unknown as Context
}

const row = (id: string, parentTopicId?: string): Record<string, unknown> => ({
  id,
  name: id,
  createdAt: 1,
  updatedAt: 2,
  provider: 'p',
  model: 'm',
  ...(parentTopicId === undefined ? {} : { parentTopicId })
})

beforeEach(async () => {
  dir = await createTempUserData()
  vi.mocked(app.getPath).mockImplementation((key: string) => (key === 'userData' ? dir : `/mock/${key}`))
})

afterEach(async () => {
  if (dir.length > 0) await rm(dir, { recursive: true, force: true })
})

describe('M 项机测替代（内核侧状态播种 + 直调内核）', () => {
  it("M2'：库里有会话 X、注册表不含 X → 清扫把它当孤儿清掉，**绝不把 X 写回注册表**", async () => {
    // 这条对应"剪除后发送"的内核侧半边：渲染层的建册门控（拒绝为已遗忘的 id 建册）由
    // kernelChat.ensureTopic.test.ts 覆盖；这里验内核不会反过来把孤儿会话重新登记。
    await seedKernelState({ dir, registry: { topics: [] }, sessions: [{ id: 'sess-x', events: 2 }] })
    expect(await readRegistryTopicIds(dir)).toEqual([])
    await loadRegistry(dir)

    await initTopics(makeCtx(['sess-x']))

    expect(await readRegistryTopicIds(dir)).toEqual([]) // 注册表里没有 X
    expect(await readSessionIds(dir)).toEqual([]) // 会话 X 被当孤儿清掉
  })

  it("M4'：删除话题 → 「重启」后该话题不复活（注册表与库都不再含它）", async () => {
    await seedKernelState({
      dir,
      registry: { topics: [row('sess-x')] },
      sessions: [{ id: 'sess-x', events: 2 }]
    })
    await loadRegistry(dir)

    await deleteTopic(makeCtx(['sess-x']), 'sess-x')

    expect(await readRegistryTopicIds(dir)).toEqual([])
    expect(await readSessionIds(dir)).toEqual([])

    // 「重启」：重新加载注册表并再跑一次启动清扫，仍不得复活
    expect(await loadRegistry(dir)).toBe('loaded')
    await initTopics(makeCtx([]))

    expect(await readRegistryTopicIds(dir)).toEqual([])
    expect(await readSessionIds(dir)).toEqual([])
  })

  it("M5'：注册表里的 fork 子行父已不存在 → 悬空子行随其会话一并清除（不留「子在而父不在」）", async () => {
    await seedKernelState({
      dir,
      registry: { topics: [row('child-x', 'parent-gone')] },
      sessions: [{ id: 'child-x', events: 2 }]
    })
    await loadRegistry(dir)

    await initTopics(makeCtx(['child-x']))

    expect(await readRegistryTopicIds(dir)).toEqual([])
    expect(await readSessionIds(dir)).toEqual([])
  })

  it("M5' 对照：父在、子也在 → 一行都不动（fork 血缘不被误剪）", async () => {
    await seedKernelState({
      dir,
      registry: { topics: [row('parent-x'), row('child-x', 'parent-x')] },
      sessions: [
        { id: 'parent-x', events: 2 },
        { id: 'child-x', events: 3 }
      ]
    })
    await loadRegistry(dir)

    await initTopics(makeCtx(['parent-x', 'child-x']))

    expect(await readRegistryTopicIds(dir)).toEqual(['parent-x', 'child-x'])
    expect(await readSessionIds(dir)).toEqual(['child-x', 'parent-x'])
  })
})
