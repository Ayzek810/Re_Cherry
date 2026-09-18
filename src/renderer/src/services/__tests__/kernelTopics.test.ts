import { type Topic, TopicType } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as KernelTopicsModule from '../kernelTopics'

/**
 * v0.3.0-2 目标 B（`report.md` §3.3.2 / §3.4）的对账逻辑单测。
 *
 * 这里守两件事：
 *   ① **成员资格问内核**——渲染层不得再用自己那份 persist 推断内核那份的可见性；
 *   ② **只有"上次会话留下的行"才可能被判失效**——本进程内新建的话题在首发建册前内核本来就不认识，
 *      不能因此被剪掉（`report.md` §3.4 的 B-6，本改动最容易踩的坑）。
 *
 * store 与两个 action 以桩注入：本文件测"对账做了什么决定"，不是 Redux 语义
 * （reducer 语义另见 `store/__tests__/assistants.pruneTopics.test.ts`）。
 */
const dispatch = vi.fn()
let assistantsState: Array<{ id: string; topics: Topic[] }> = []

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({ assistants: { assistants: assistantsState } }),
    dispatch: (action: unknown) => {
      // 桩 store 按 reducer 语义应用 pruneTopics（含子树级联）：对账在归还历史污染行后会
      // 重读 store，桩不删行的话"归还"在测试里就是空话（真实 reducer 见 assistants.pruneTopics.test.ts）。
      const a = action as {
        type?: string
        payload?: { assistantId: string; topicIds: string[] } | { assistantId: string; topic: Topic }
      }
      if (a.type === 'assistants/pruneTopics' && a.payload !== undefined && 'topicIds' in a.payload) {
        const target = assistantsState.find((row) => row.id === a.payload?.assistantId)
        if (target !== undefined) {
          const removed = new Set(a.payload.topicIds)
          for (let changed = true; changed; ) {
            changed = false
            for (const t of target.topics) {
              if (!removed.has(t.id) && t.parentTopicId !== undefined && removed.has(t.parentTopicId)) {
                removed.add(t.id)
                changed = true
              }
            }
          }
          target.topics = target.topics.filter((t) => !removed.has(t.id))
        }
      }
      if (a.type === 'assistants/updateTopic' && a.payload !== undefined && 'topic' in a.payload) {
        // 桩 store 按 reducer 语义应用 updateTopic（按 id 整行替换）
        const updated = a.payload
        const target = assistantsState.find((row) => row.id === updated.assistantId)
        if (target !== undefined) {
          target.topics = target.topics.map((t) => (t.id === updated.topic.id ? { ...updated.topic } : t))
        }
      }
      dispatch(action)
    }
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  addTopic: (payload: unknown) => ({ type: 'assistants/addTopic', payload }),
  pruneTopics: (payload: unknown) => ({ type: 'assistants/pruneTopics', payload }),
  updateTopic: (payload: unknown) => ({ type: 'assistants/updateTopic', payload })
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultTopic: (assistantId: string) => ({
    id: 'fresh-topic',
    type: 'chat',
    assistantId,
    name: '默认话题',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    messages: []
  })
}))

function topic(id: string, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    type: TopicType.Chat,
    assistantId: 'assistant-1',
    name: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...extra
  }
}

function kernelRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `kernel-${id}`,
    createdAt: Date.parse('2026-08-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-08-02T00:00:00.000Z'),
    ...extra
  }
}

function stubApi(list: unknown, get?: unknown): void {
  ;(window as unknown as { api: unknown }).api = {
    dshTopicList: typeof list === 'function' ? list : vi.fn().mockResolvedValue(list),
    dshTopicGet: typeof get === 'function' ? get : vi.fn().mockResolvedValue(get ?? {})
  }
}

/**
 * 每个用例重新取模块实例：`restoredTopicIds` 与内核缓存都是模块内状态。
 * 必须先 resetModules 再登记，否则登记的是上一份实例（对账读的是新实例）。
 */
async function loadReconcile(restoredTopicIds: string[]): Promise<typeof KernelTopicsModule> {
  vi.resetModules()
  const branch = await import('@renderer/utils/topicBranch')
  branch.noteRestoredTopicIds(restoredTopicIds)
  return await import('../kernelTopics')
}

beforeEach(() => {
  dispatch.mockClear()
  assistantsState = [{ id: 'assistant-1', topics: [topic('topic-a')] }]
  stubApi({ topics: [] })
})

describe('reconcileAssistantTopicRows（行集合以内核为权威）', () => {
  it('内核未知（IPC 失败）→ 返回 null 且**不动任何行**（宁可多显示也不误删）', async () => {
    stubApi(() => Promise.reject(new Error('ipc down')))
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-a'])

    await expect(reconcileAssistantTopicRows('assistant-1', { attempts: 1 })).resolves.toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('启动窗口内第一次查不到、随后就绪 → **重试后照常对账**（不是"未知"，是"内核还没起来"）', async () => {
    // 主进程建窗口与启动内核是并行的（main/index.ts），dsh:* 的 handler 要等 initTopics 之后才注册；
    // 这期间的失败是瞬时的，只试一次就会一直停在"显示全部"（真机 2026-09-15 现象）。
    let calls = 0
    const listApi = vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('No handler registered')) : Promise.resolve({ topics: [] })
    })
    vi.stubGlobal('window', { ...globalThis.window, api: { dshTopicList: listApi, dshTopicGet: vi.fn() } })
    assistantsState = [{ id: 'assistant-1', topics: [topic('topic-stale')] }]
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-stale'])

    const rows = await reconcileAssistantTopicRows('assistant-1', { attempts: 3, delayMs: 1 })

    expect(listApi).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/pruneTopics',
      payload: { assistantId: 'assistant-1', topicIds: ['topic-stale'] }
    })
    expect(rows?.map((row) => row.id)).toEqual(['fresh-topic'])
  })

  it('上次会话留下、内核已不认识的行 → 剪除（子树由 reducer 级联）', async () => {
    assistantsState = [
      {
        id: 'assistant-1',
        topics: [topic('topic-a'), topic('child-a', { parentTopicId: 'topic-a' }), topic('topic-b')]
      }
    ]
    stubApi({ topics: [kernelRow('topic-b')] })
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-a', 'topic-b', 'child-a'])

    const rows = await reconcileAssistantTopicRows('assistant-1')

    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/pruneTopics',
      payload: { assistantId: 'assistant-1', topicIds: ['topic-a'] }
    })
    expect(rows?.map((row) => row.id)).toEqual(['topic-b'])
  })

  it('本进程内新建、尚未建册的行 → **不剪**且照样显示（B-6 的那个坑）', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [topic('topic-new')] }]
    stubApi({ topics: [] })
    const { reconcileAssistantTopicRows } = await loadReconcile([])

    const rows = await reconcileAssistantTopicRows('assistant-1')

    expect(dispatch).not.toHaveBeenCalled()
    expect(rows?.map((row) => row.id)).toEqual(['topic-new'])
  })

  it('内核有、渲染层无 → 用**内核数据**补齐（epoch ms → ISO 只在这一处换算）', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [] }]
    stubApi({ topics: [kernelRow('topic-k')] })
    const { reconcileAssistantTopicRows } = await loadReconcile([])

    const rows = await reconcileAssistantTopicRows('assistant-1')

    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/addTopic',
      payload: {
        assistantId: 'assistant-1',
        topic: expect.objectContaining({
          id: 'topic-k',
          name: 'kernel-topic-k',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z'
        })
      }
    })
    expect(rows?.map((row) => row.id)).toEqual(['topic-k'])
  })

  it('剪干净后不留"零话题"：补建一个全新的默认话题', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [topic('topic-stale')] }]
    stubApi({ topics: [] })
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-stale'])

    const rows = await reconcileAssistantTopicRows('assistant-1')

    expect(rows?.map((row) => row.id)).toEqual(['fresh-topic'])
    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/addTopic',
      payload: { assistantId: 'assistant-1', topic: expect.objectContaining({ id: 'fresh-topic' }) }
    })
  })

  it('存活的本地行**原样返回**（不在此合并内核字段，避免与重命名/自动标题竞态）', async () => {
    assistantsState = [
      {
        id: 'assistant-1',
        topics: [topic('topic-a', { name: '用户改过的名字', pinned: true, prompt: '话题提示词' })]
      }
    ]
    stubApi({ topics: [kernelRow('topic-a')] })
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-a'])

    const rows = await reconcileAssistantTopicRows('assistant-1')

    expect(rows).toHaveLength(1)
    expect(rows?.[0]).toMatchObject({ name: '用户改过的名字', pinned: true, prompt: '话题提示词' })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('reconcileAssistantTopicRows（助手分离：内核注册表扁平，归属以渲染层行为准）', () => {
  it('内核有、但已由**其他助手**持有的行 → 绝不物化到当前助手名下（话题分离）', async () => {
    assistantsState = [
      { id: 'assistant-1', topics: [] },
      { id: 'assistant-2', topics: [topic('topic-of-2', { assistantId: 'assistant-2' })] }
    ]
    stubApi({ topics: [kernelRow('topic-of-2')] })
    const { reconcileAssistantTopicRows } = await loadReconcile([])

    const rows = await reconcileAssistantTopicRows('assistant-1', { attempts: 1 })

    // 不 addTopic（topic-of-2 是 assistant-2 的）；assistant-1 对账后无行 → ④ 兜底建默认话题
    const addCalls = dispatch.mock.calls.filter((call) => (call[0] as { type: string }).type === 'assistants/addTopic')
    expect(addCalls).toHaveLength(1)
    expect((addCalls[0][0] as { payload: { topic: { id: string } } }).payload.topic.id).toBe('fresh-topic')
    expect(rows?.map((row) => row.id)).toEqual(['fresh-topic'])
  })

  it('历史污染（当前助手持有别助手的行）→ 归还：prune 本助手这份，不碰原主人的', async () => {
    assistantsState = [
      { id: 'assistant-1', topics: [topic('topic-of-2'), topic('topic-1-own')] },
      { id: 'assistant-2', topics: [topic('topic-of-2', { assistantId: 'assistant-2' })] }
    ]
    stubApi({ topics: [kernelRow('topic-of-2'), kernelRow('topic-1-own')] })
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-of-2', 'topic-1-own'])

    const rows = await reconcileAssistantTopicRows('assistant-1', { attempts: 1 })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/pruneTopics',
      payload: { assistantId: 'assistant-1', topicIds: ['topic-of-2'] }
    })
    expect(rows?.map((row) => row.id)).toEqual(['topic-1-own'])
  })

  it('孤儿行（任何助手都没有）→ 仍由当前对账收留（救援语义不变）', async () => {
    assistantsState = [
      { id: 'assistant-1', topics: [] },
      { id: 'assistant-2', topics: [topic('topic-of-2', { assistantId: 'assistant-2' })] }
    ]
    stubApi({ topics: [kernelRow('topic-of-2'), kernelRow('topic-orphan')] })
    const { reconcileAssistantTopicRows } = await loadReconcile([])

    const rows = await reconcileAssistantTopicRows('assistant-1', { attempts: 1 })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/addTopic',
      payload: { assistantId: 'assistant-1', topic: expect.objectContaining({ id: 'topic-orphan' }) }
    })
    expect(rows?.map((row) => row.id)).toEqual(['topic-orphan'])
  })

  it('归还重复根行时，把它的 lastViewedBranchId 转移给主人副本（主人那份没有记忆时）', async () => {
    // 用户在污染副本上看到的"最后浏览分支"不能随归还剪除一起丢
    assistantsState = [
      { id: 'assistant-1', topics: [topic('topic-of-2', { lastViewedBranchId: 'branch-x' })] },
      {
        id: 'assistant-2',
        topics: [
          topic('topic-of-2', { assistantId: 'assistant-2' }),
          topic('branch-x', { assistantId: 'assistant-2', parentTopicId: 'topic-of-2' })
        ]
      }
    ]
    stubApi({ topics: [kernelRow('topic-of-2')] })
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-of-2', 'branch-x'])

    await reconcileAssistantTopicRows('assistant-1', { attempts: 1 })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/updateTopic',
      payload: {
        assistantId: 'assistant-2',
        topic: expect.objectContaining({ id: 'topic-of-2', lastViewedBranchId: 'branch-x' })
      }
    })
    // 桩已应用：主人副本确实带上了记忆
    const ownerCopy = assistantsState
      .find((row) => row.id === 'assistant-2')
      ?.topics.find((row) => row.id === 'topic-of-2')
    expect(ownerCopy?.lastViewedBranchId).toBe('branch-x')
  })

  it('lastViewedBranchId 指向本助手不持有的行（隔离移动后的越界指针）→ 清除', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [topic('topic-a', { lastViewedBranchId: 'branch-gone' })] }]
    stubApi({ topics: [kernelRow('topic-a')] })
    const { reconcileAssistantTopicRows } = await loadReconcile(['topic-a'])

    const rows = await reconcileAssistantTopicRows('assistant-1')

    expect(dispatch).toHaveBeenCalledWith({
      type: 'assistants/updateTopic',
      payload: {
        assistantId: 'assistant-1',
        topic: expect.objectContaining({ id: 'topic-a', lastViewedBranchId: undefined })
      }
    })
    expect(rows?.map((row) => row.id)).toEqual(['topic-a'])
  })
})
