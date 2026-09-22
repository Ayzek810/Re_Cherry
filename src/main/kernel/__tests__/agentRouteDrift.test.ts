import { rm } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import { app } from 'electron'
vi.mock('@main/services/SearchService', () => ({
  searchService: new Proxy({}, { get: () => vi.fn() }),
  SearchService: class {}
}))
vi.mock('@main/services/webSearchProviders/webFetch', () => ({ fetchWebContent: vi.fn(async () => ({ content: '' })) }))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTempUserData, seedKernelState } from './helpers/seedKernelState'

/**
 * v0.3.1 路由漂移重挂（真机回归：fork 话题后连切 Qwen/V4，六轮请求仍全发给首建时的
 * Kimi）。dsh 只在 create/resume 时消费 agentOptions——活体 agent 不会随后续 createTopic
 * upsert 自动换模型。ensureAgent 必须识别"注册表路由已变、活体还持旧路由"并重挂。
 *
 * 环境事实同 `topicLifecycleMachineTests.test.ts`：unmock 真实 fs/os/path，
 * `app.getPath('userData')` 指向临时目录；ctx.agents 用最小替身记录 create/resume 与 dispose。
 */
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

const { clearLiveHandles, createTopic, loadRegistry } = await import('../topics')

let dir = ''

interface RecordedCall {
  op: 'create' | 'resume'
  provider: string
  model: string
}

/** 最小 agents 替身：记录建载路由；`get` 可被测试改为 `{ status: 'running' }` 模拟流式中。 */
const makeRouteCtx = (persistedIds: string[]) => {
  const calls: RecordedCall[] = []
  const disposals: string[] = []
  const makeHandle = (id: string) => ({
    agent: { session: { id } },
    dispose: async () => {
      disposals.push(id)
    }
  })
  const agents = {
    create: async (args: { sessionId: string; agentOptions: { provider: string; model: string } }) => {
      calls.push({ op: 'create', ...args.agentOptions })
      return makeHandle(args.sessionId)
    },
    resume: async (args: { resumeSessionId: string; agentOptions: { provider: string; model: string } }) => {
      calls.push({ op: 'resume', ...args.agentOptions })
      return makeHandle(args.resumeSessionId)
    },
    get: (_id: string) => undefined
  }
  const ctx = {
    sessionPersistence: { list: async () => persistedIds.map((id) => ({ id })) },
    on: vi.fn(),
    agents
  } as unknown as Context
  return { ctx, calls, disposals, agents }
}

beforeEach(async () => {
  dir = await createTempUserData()
  vi.mocked(app.getPath).mockImplementation((key: string) => (key === 'userData' ? dir : `/mock/${key}`))
})

afterEach(async () => {
  clearLiveHandles()
  if (dir.length > 0) await rm(dir, { recursive: true, force: true })
})

describe('ensureAgent 路由漂移重挂', () => {
  it('同话题 upsert 换模型 → 旧活体 dispose，新路由进 resume；同路由幂等不重挂', async () => {
    await seedKernelState({ dir, registry: { topics: [] }, sessions: [{ id: 'sess-x', events: 1 }] })
    await loadRegistry(dir)
    const { ctx, calls, disposals } = makeRouteCtx(['sess-x'])

    await createTopic(ctx, { id: 'sess-x', provider: 'silicon', model: 'Pro/moonshotai/Kimi-K2.6' })
    expect(calls).toEqual([{ op: 'resume', provider: 'silicon', model: 'Pro/moonshotai/Kimi-K2.6' }])
    expect(disposals).toEqual([])

    // 模型切换（真机六连切的简化形）
    await createTopic(ctx, { id: 'sess-x', provider: 'silicon', model: 'Qwen/Qwen3-8B' })
    expect(disposals).toEqual(['sess-x'])
    expect(calls[1]).toEqual({ op: 'resume', provider: 'silicon', model: 'Qwen/Qwen3-8B' })

    // 未再漂移 → 幂等：不拆不重挂
    await createTopic(ctx, { id: 'sess-x', provider: 'silicon', model: 'Qwen/Qwen3-8B' })
    expect(disposals).toEqual(['sess-x'])
    expect(calls).toHaveLength(2)
  })

  it('流式回合进行中不拆活体；回合结束后下一次 ensure 自然按新路由重挂', async () => {
    await seedKernelState({ dir, registry: { topics: [] }, sessions: [{ id: 'sess-x', events: 1 }] })
    await loadRegistry(dir)
    const { ctx, calls, disposals, agents } = makeRouteCtx(['sess-x'])

    await createTopic(ctx, { id: 'sess-x', provider: 'silicon', model: 'Pro/moonshotai/Kimi-K2.6' })
    expect(calls).toHaveLength(1)

    // 流式中切模型：沿用旧活体，不 dispose
    agents.get = (_id: string) => ({ status: 'running' }) as unknown as ReturnType<typeof agents.get>
    await createTopic(ctx, { id: 'sess-x', provider: 'silicon', model: 'Qwen/Qwen3-8B' })
    expect(disposals).toEqual([])
    expect(calls).toHaveLength(1)

    // 回合结束（get 无 running）→ 下一次 upsert 触发重挂
    agents.get = (_id: string) => undefined
    await createTopic(ctx, { id: 'sess-x', provider: 'silicon', model: 'Qwen/Qwen3-8B' })
    expect(disposals).toEqual(['sess-x'])
    expect(calls[1]).toEqual({ op: 'resume', provider: 'silicon', model: 'Qwen/Qwen3-8B' })
  })
})
