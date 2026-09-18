import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 话题自动命名（service/topicNaming.ts，v0.3.1）的单测。
 *
 * 钉四件事：
 *   ① 五道门逐一到位（缺名行/手改/分支/非默认名/消息<2 → 什么都不干，不调模型）；
 *   ② 开关开：走 fetchMessagesSummary（快速模型路径），成功落名走**双路**
 *      （updateTopicName 免 bump + Dsh_TopicRename 注册表）；
 *   ③ 命名失败/为空/开关关：降级到首条用户消息截断名（开关关时**不调模型**）；
 *   ④ 注册表写失败只记日志不抛（fire-and-forget，注册表是恢复语义不是显示语义）。
 *
 * store / settings / ApiService / find / i18n 全部桩注入（对照 kernelTopics.test.ts 的模式）；
 * Redux 侧的免 bump 语义另由 store/__tests__/updateTopicName.test.ts 钉。
 */
const dispatched: Array<{ type: string; payload: unknown }> = []
let assistantsState: Array<{ id: string; topics: Array<Record<string, unknown>> }> = []
let messagesState: Message[] = []
let settingsState: { enableTopicNaming: boolean } = { enableTopicNaming: true }
let summaryResult: { text: string | null; error?: string } | 'throw' = { text: '生成名' }
let firstMessageBlocks: Array<{ content: string }> = [{ content: '第一句话的内容' }]
let mainTextOfFirst = '第一句话的内容'
const renameApi = vi.fn(() => Promise.resolve({ topic: {} }))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      assistants: { assistants: assistantsState },
      messages: { messageIdsByTopic: {}, entities: {} }
    }),
    dispatch: (action: { type: string; payload?: unknown }) => {
      dispatched.push({ type: action.type, payload: action.payload })
    }
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  // 与真实 action 生成器同形：payload 原样进 dispatch 队列供断言
  updateTopicName: (payload: unknown) => ({ type: 'assistants/updateTopicName', payload })
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectMessagesForTopic: () => messagesState
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: (key: 'enableTopicNaming') => settingsState[key]
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => (key === 'chat.default.topic.name' ? '默认话题' : key) }
}))

const { summaryApi } = vi.hoisted(() => ({ summaryApi: vi.fn() }))

vi.mock('@renderer/services/ApiService', () => ({
  fetchMessagesSummary: summaryApi
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  findMainTextBlocks: () => firstMessageBlocks
}))

vi.mock('@renderer/utils/naming', () => ({
  truncateText: (text: string) => (text === mainTextOfFirst ? '截断名' : text)
}))

function row(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: '默认话题', isNameManuallyEdited: false, ...extra }
}

beforeEach(() => {
  dispatched.length = 0
  assistantsState = [{ id: 'assistant-1', topics: [row('topic-a')] }]
  messagesState = [{ id: 'm1' } as Message, { id: 'm2' } as Message]
  settingsState = { enableTopicNaming: true }
  summaryResult = { text: '生成名' }
  firstMessageBlocks = [{ content: '第一句话的内容' }]
  mainTextOfFirst = '第一句话的内容'
  renameApi.mockClear()
  summaryApi.mockReset()
  summaryApi.mockImplementation(() =>
    summaryResult === 'throw' ? Promise.reject(new Error('quota')) : Promise.resolve(summaryResult)
  )
  vi.stubGlobal('window', { ...globalThis.window, api: { dshTopicRename: renameApi } })
})

describe('autoNameKernelTopic（五道门 + 双路落名）', () => {
  it('门全过 + 开关开 → fetchMessagesSummary 命中，双路落名（免 bump + 注册表）', async () => {
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toContainEqual({
      type: 'assistants/updateTopicName',
      payload: { topicId: 'topic-a', name: '生成名' }
    })
    expect(renameApi).toHaveBeenCalledWith('topic-a', '生成名')
  })

  it('手动改过名 → 永不自动盖（V1 同款豁免）', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [row('topic-a', { isNameManuallyEdited: true })] }]
    const { autoNameKernelTopic } = await import('../topicNaming')
    summaryApi.mockClear()
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toHaveLength(0)
    expect(summaryApi).not.toHaveBeenCalled()
    expect(renameApi).not.toHaveBeenCalled()
  })

  it('分支行不自动命名（保持 fork 无名语义）', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [row('topic-a', { parentTopicId: 'root' })] }]
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toHaveLength(0)
    expect(renameApi).not.toHaveBeenCalled()
  })

  it('名字已不是默认占位 → 不重命名', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [row('topic-a', { name: '已有名' })] }]
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toHaveLength(0)
  })

  it('消息不足两条 → 不命名（首条还没换来回答）', async () => {
    messagesState = [{ id: 'm1' } as Message]
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toHaveLength(0)
  })

  it('行不存在（未建册的新话题）→ 什么都不干', async () => {
    assistantsState = [{ id: 'assistant-1', topics: [] }]
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('ghost')

    expect(dispatched).toHaveLength(0)
  })
})

describe('降级面（模型失败/为空/开关关）', () => {
  it('summary 抛错 → warn + 首条消息截断名兜底', async () => {
    summaryResult = 'throw'
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toContainEqual({
      type: 'assistants/updateTopicName',
      payload: { topicId: 'topic-a', name: '截断名' }
    })
    expect(renameApi).toHaveBeenCalledWith('topic-a', '截断名')
  })

  it('summary 为空 → 兜底', async () => {
    summaryResult = { text: null }
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toContainEqual({
      type: 'assistants/updateTopicName',
      payload: { topicId: 'topic-a', name: '截断名' }
    })
  })

  it('开关关 → 不调模型，直接首条消息兜底（V1 语义：省钱）', async () => {
    settingsState = { enableTopicNaming: false }
    const { autoNameKernelTopic } = await import('../topicNaming')
    summaryApi.mockClear()
    await autoNameKernelTopic('topic-a')

    expect(summaryApi).not.toHaveBeenCalled()
    expect(dispatched).toContainEqual({
      type: 'assistants/updateTopicName',
      payload: { topicId: 'topic-a', name: '截断名' }
    })
  })

  it('首条消息无正文（纯图片轮）→ 最终为空，什么都不写', async () => {
    summaryResult = { text: null }
    firstMessageBlocks = []
    const { autoNameKernelTopic } = await import('../topicNaming')
    await autoNameKernelTopic('topic-a')

    expect(dispatched).toHaveLength(0)
    expect(renameApi).not.toHaveBeenCalled()
  })
})

describe('syncTopicNameToKernel（注册表路）', () => {
  it('IPC 失败 → 吞掉只记日志，无未处理拒绝（绝不阻塞渲染层）', async () => {
    const observed: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      observed.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      renameApi.mockImplementation(() => Promise.reject(new Error('kernel not booted')))
      const { syncTopicNameToKernel } = await import('../topicNaming')
      syncTopicNameToKernel('topic-a', '名字')
      // fire-and-forget：.catch 同步挂接，排空微任务后断言零未处理拒绝
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      expect(observed).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('空名 → 不发 IPC', async () => {
    const { syncTopicNameToKernel } = await import('../topicNaming')
    syncTopicNameToKernel('topic-a', '')
    expect(renameApi).not.toHaveBeenCalled()
  })
})
