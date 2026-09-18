import type * as ConversationTreeCacheModule from '@renderer/utils/conversationTreeCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 家族取数缓存（conversationTreeCache）失败语义的单测——分支图"节点凭空消失"事故
 * （v0.3.0-5）的回归防线：
 *   ① 拉取**失败**绝不吞成空集合（空 = "该分支零轮次"的确定答案，失败 = "不知道"）；
 *      混淆二者时，一次瞬时 IPC 失败就让该分支在图上一个节点都不剩，而消息区照常渲染。
 *   ② 瞬时失败在窗口内重试自愈；
 *   ③ 持续失败 → 整棵家族 reject，且坏结果不进缓存（同签名重试是真重试）；
 *   ④ 确定性"内核无此行"（not found）→ 该分支按空会话解析（真实状态，不是失败）。
 *
 * 取数链直通用真实实现（fetchTopicEventsWithRetry / retryKernelQuery / 分类器全部真实），
 * 只桩 window.api IPC——语义测试覆盖的就是这条链。缓存是模块级单例：每个用例 resetModules。
 */

const IPC = () => (window as unknown as { api: Record<string, unknown> }).api

async function freshCache(): Promise<typeof ConversationTreeCacheModule> {
  vi.resetModules()
  return await import('@renderer/utils/conversationTreeCache')
}

function userEvent(seq: number) {
  return {
    seq,
    time: 1000,
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'q' + seq }] }
  }
}

function stubApi(options: {
  branches?: Array<{ id: string; parentTopicId?: string }>
  events?: (topicId: string, callIndexByTopic: Record<string, number>) => Promise<unknown>
}): void {
  const callIndex: Record<string, number> = {}
  const branches =
    options.branches !== undefined
      ? vi.fn().mockResolvedValue({ topics: options.branches })
      : vi.fn().mockResolvedValue({ topics: [] })
  const events = vi.fn(async (topicId: string) => {
    callIndex[topicId] = (callIndex[topicId] ?? 0) + 1
    if (options.events === undefined) return { events: [] }
    return await options.events(topicId, callIndex)
  })
  ;(window as unknown as { api: unknown }).api = { dshTopicBranches: branches, dshTopicEvents: events }
}

beforeEach(() => {
  stubApi({})
})

describe('loadConversationTree（失败绝不伪装成空）', () => {
  it('成功路径：全部分支的轮次完整（吞错误的旧行为把 turns 变成空数组）', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({ branches: [{ id: 'root-1' }, { id: 'branch-1', parentTopicId: 'root-1' }] })
    stubApi({
      branches: [{ id: 'root-1' }, { id: 'branch-1', parentTopicId: 'root-1' }],
      events: async () => ({ events: [userEvent(1)] })
    })

    const family = await loadConversationTree('root-1', 'sig-1')

    expect(family.sessions.map((s) => s.id).sort()).toEqual(['branch-1', 'root-1'])
    for (const session of family.sessions) expect(session.turns.length).toBe(1)
  })

  it('同签名二次取数命中缓存（不重复 IPC）', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({
      branches: [{ id: 'root-1' }],
      events: async () => ({ events: [userEvent(1)] })
    })

    await loadConversationTree('root-1', 'sig-1')
    await loadConversationTree('root-1', 'sig-1')

    expect(IPC().dshTopicEvents).toHaveBeenCalledTimes(1)
  })

  it('瞬时失败（session is not loaded 类抖动）→ 窗口内重试自愈，轮次不丢', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({
      branches: [{ id: 'root-1' }, { id: 'branch-1', parentTopicId: 'root-1' }],
      // branch-1 第一次抛错、第二次成功（主进程 tree.open 异步 resume 竞态的形态）
      events: async (topicId, callIndex) => {
        if (topicId === 'branch-1' && callIndex[topicId] === 1) {
          throw new Error('session is not loaded')
        }
        return { events: [userEvent(1)] }
      }
    })

    const family = await loadConversationTree('root-1', 'sig-1')

    expect(family.byId.get('branch-1')?.turns.length).toBe(1)
  })

  it('持续性瞬时失败 → 整棵家族 reject（而不是渲染缺分支的假树）', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({
      branches: [{ id: 'root-1' }, { id: 'branch-1', parentTopicId: 'root-1' }],
      events: async () => {
        throw new Error('session is not loaded')
      }
    })

    await expect(loadConversationTree('root-1', 'sig-1')).rejects.toThrow('session events unavailable')
  })

  it('失败结果不进缓存：同签名再取是真重试（新 IPC，而非同一个坏 promise）', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({
      branches: [{ id: 'root-1' }],
      events: async () => {
        throw new Error('ipc down')
      }
    })

    await expect(loadConversationTree('root-1', 'sig-1')).rejects.toThrow()
    await expect(loadConversationTree('root-1', 'sig-1')).rejects.toThrow()

    // 每次取数 = 缓存层收窄的 3 次重试窗口；若坏 promise 被缓存，这里只会是 3
    expect(IPC().dshTopicEvents).toHaveBeenCalledTimes(6)
  })

  it('分支列表本身拉取失败 → reject（不是把家族当空）', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({
      branches: undefined,
      events: async () => ({ events: [] })
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.dshTopicBranches = vi
      .fn()
      .mockRejectedValue(new Error('ipc down'))

    await expect(loadConversationTree('root-1', 'sig-1')).rejects.toThrow('branch list unavailable')
  })

  it('确定性"内核无此行"（not found）→ 该分支按空会话解析，不重试不 reject', async () => {
    const { loadConversationTree } = await freshCache()
    stubApi({
      branches: [{ id: 'root-1' }, { id: 'branch-1', parentTopicId: 'root-1' }],
      events: async (topicId) => {
        if (topicId === 'branch-1') throw new Error('kernel: topic "branch-1" not found')
        return { events: [userEvent(1)] }
      }
    })

    const family = await loadConversationTree('root-1', 'sig-1')

    // not found = 注册表确实没有（真实状态），该分支零轮次；根不受影响
    expect(family.byId.get('root-1')?.turns.length).toBe(1)
    expect(family.byId.get('branch-1')?.turns.length).toBe(0)
    // 确定性答案不重试：branch-1 只被取数一次
    const eventsCalls = (IPC().dshTopicEvents as { mock: { calls: unknown[][] } }).mock.calls
    const branchCalls = eventsCalls.filter((call) => call[0] === 'branch-1')
    expect(branchCalls.length).toBe(1)
  })
})
