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
    dispatch: (action: unknown) => dispatch(action)
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  addTopic: (payload: unknown) => ({ type: 'assistants/addTopic', payload }),
  pruneTopics: (payload: unknown) => ({ type: 'assistants/pruneTopics', payload })
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
