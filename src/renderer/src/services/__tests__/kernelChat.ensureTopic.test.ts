import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ensureKernelTopic } from '../kernelChat'
import type * as KernelChatModule from '../kernelChat'

/**
 * v0.3.0-2 目标 B（`report.md` §3.3.2-5 / §3.4 的 B-5、§4 的 M2）：`ensureKernelTopic` **只服务真正新建的话题**。
 *
 * 背景：`dshTopicCreate` 是 **upsert**，对"内核已遗忘的 id"调用会让该 id **复活**——直接违反内核兼容契约
 * 第 4 节的墓碑纪律，也正是 `report.md` §2.2 列的"复活点"（`messageThunk.ts:291`）。
 * 真机 M2 要对比 `topics.json` 前后，这里用桩把同一判定钉住：**来自上次会话的行**必须先由内核确认存在。
 *
 * `kernelChat.ts` 的 import 面很大（Redux 各 slice / 事件流桥 / 块构造器…），为了让本文件只测这一条判定，
 * 把与判定无关的模块整体桩掉。
 */
const assistant = {
  id: 'assistant-1',
  prompt: 'system prompt',
  model: { id: 'model-1', provider: 'provider-1' },
  settings: { maxTokens: 100 }
} as unknown as Parameters<typeof ensureKernelTopic>[1]

vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ assistants: { assistants: [] } }), dispatch: vi.fn() }
}))
vi.mock('@renderer/store/assistants', () => ({ updateTopic: vi.fn(), updateTopicUpdatedAt: vi.fn() }))
vi.mock('@renderer/store/messageBlock', () => ({ updateOneBlock: vi.fn(), upsertManyBlocks: vi.fn() }))
vi.mock('@renderer/store/newMessage', () => ({ newMessagesActions: {} }))
vi.mock('@renderer/store/toolPermissions', () => ({ toolPermissionsActions: {} }))
vi.mock('@renderer/store/userQuestions', () => ({ userQuestionsActions: {} }))
vi.mock('@renderer/services/kernelEventStream', () => ({
  fetchTopicEvents: vi.fn(),
  subscribeKernelSessionEvents: vi.fn()
}))
vi.mock('@renderer/utils/messageUtils/create', () => ({
  createMainTextBlock: vi.fn(),
  createThinkingBlock: vi.fn(),
  createToolBlock: vi.fn()
}))
vi.mock('@renderer/utils/abortController', () => ({ renameAbortController: vi.fn() }))
// 以下两个只被"思考档位映射"用到，与本文件测的建册门控无关；不桩掉会让首个用例付出整张
// provider/model 配置图的加载代价（实测 ~17s）。
vi.mock('@renderer/config/reasoningCompat', () => ({ providerReasoningCompat: vi.fn(() => undefined) }))
vi.mock('@renderer/utils/reasoningKernel', () => ({
  kernelReasoningEffortsForModel: vi.fn(() => []),
  kernelReasoningLevelFor: vi.fn(() => undefined)
}))

let createTopic: ReturnType<typeof vi.fn>
let getTopic: ReturnType<typeof vi.fn>

/**
 * 冷 import 容忍上限：loadEnsure 在 it() 内拉起整张 kernelChat 模块图（见文件头，
 * 已桩掉最重的 reasoning 配置图，剩余部分实测 ~17s）。全量并行跑时机器热负载下
 * 会越过 vitest 默认 20s（真机复现 3/3 超时、隔离跑必过）——按用例放宽，不改判定。
 */
const COLD_IMPORT_TIMEOUT_MS = 60_000

function stubApi(knownTopic: unknown): void {
  createTopic = vi.fn().mockResolvedValue({ topic: { id: 'x' } })
  getTopic = vi.fn().mockResolvedValue(knownTopic === null ? {} : { topic: knownTopic })
  ;(window as unknown as { api: unknown }).api = {
    dshTopicCreate: createTopic,
    dshTopicGet: getTopic,
    dshTopicList: vi.fn().mockResolvedValue({ topics: [] })
  }
}

/** 每次重新取模块：`restoredTopicIds` 与内核集合缓存都是模块内状态。 */
async function loadEnsure(restoredTopicIds: string[], knownTopic: unknown): Promise<typeof KernelChatModule> {
  vi.resetModules()
  const branch = await import('@renderer/utils/topicBranch')
  branch.noteRestoredTopicIds(restoredTopicIds)
  stubApi(knownTopic)
  return await import('../kernelChat')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ensureKernelTopic 的建册门控（B-5 / M2）', () => {
  it(
    '上次会话留下的行、内核已不认识 → **拒绝建册**（不 upsert，不复活墓碑 id）',
    { timeout: COLD_IMPORT_TIMEOUT_MS },
    async () => {
      const { ensureKernelTopic: ensure } = await loadEnsure(['topic-stale'], null)

      await expect(ensure('topic-stale', assistant)).rejects.toThrow(/refusing to recreate/)
      expect(createTopic).not.toHaveBeenCalled()
    }
  )

  it('上次会话留下的行、内核认识 → 正常建册（幂等 upsert，不误拒）', { timeout: COLD_IMPORT_TIMEOUT_MS }, async () => {
    const { ensureKernelTopic: ensure } = await loadEnsure(['topic-live'], { id: 'topic-live', name: 'live' })

    await expect(ensure('topic-live', assistant)).resolves.toBeUndefined()
    expect(createTopic).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'topic-live', systemPrompt: 'system prompt' })
    )
  })

  it('本进程内新建的行 → 不查库、直接建册（首发建册的正常路径）', { timeout: COLD_IMPORT_TIMEOUT_MS }, async () => {
    const { ensureKernelTopic: ensure } = await loadEnsure([], null)

    await expect(ensure('topic-new', assistant)).resolves.toBeUndefined()
    expect(getTopic).not.toHaveBeenCalled()
    expect(createTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-new' }))
  })

  it(
    '验C-1 集成半边：启动窗口内第一次问不到、随后问到 → **不拒绝**、照常建册',
    { timeout: COLD_IMPORT_TIMEOUT_MS },
    async () => {
      // 旧实现在这里会因 `null` 放行而"碰巧"建册成功，但那是把"暂时不知道"当成"知道"：
      // 若该行其实已被内核遗忘，upsert 就会复活墓碑 id。重试后拿到确定性答案，语义才成立。
      const { ensureKernelTopic: ensure } = await loadEnsure(['topic-live'], { id: 'topic-live', name: 'live' })
      getTopic.mockRejectedValueOnce(new Error('No handler registered'))

      await expect(ensure('topic-live', assistant)).resolves.toBeUndefined()
      expect(getTopic).toHaveBeenCalledTimes(2)
      expect(createTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-live' }))
    }
  )

  it(
    '查询失败（内核不可达）→ **不拒绝**：建册走的是同一个内核，此时拒绝只会把主操作也挡掉',
    { timeout: COLD_IMPORT_TIMEOUT_MS },
    async () => {
      const { ensureKernelTopic: ensure } = await loadEnsure(['topic-unknown'], null)
      getTopic.mockRejectedValue(new Error('ipc down'))

      await expect(ensure('topic-unknown', assistant)).resolves.toBeUndefined()
      expect(createTopic).toHaveBeenCalled()
    }
  )
})
