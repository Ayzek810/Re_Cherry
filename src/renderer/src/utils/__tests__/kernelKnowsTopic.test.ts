import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as TopicBranchModule from '../topicBranch'

/**
 * v0.3.0-3 问题 C（`report.md` §1.4 的验C-1 / 验C-2 / 验C-3 / 验C-5）：
 * `kernelKnowsTopic` 的**启动窗口重试**。
 *
 * 背景：该查询服务于"拒绝复活"的判定（`ensureKernelTopic` 据此决定是否允许 upsert），而主进程
 * 建窗口与启动内核是并行的——handler 注册前它只会拿到 "No handler registered"。旧实现只试一次、
 * 失败即返回 `null`，而调用方对 `null` 是 fail-open ⇒ **启动窗口内会把"暂时不知道"当成"知道"**，
 * 于是 `dshTopicCreate`（upsert）复活一个内核已遗忘的 id（违反内核兼容契约第 4 节）。
 *
 * **信号效力边界**：以下均为桩 IPC 的单测。真机"启动窗口内发送"的时序**未实测**（无从精确控制
 * handler 注册时刻），本轮只主张"与列表路径同口径"的逻辑等价性。
 */
const KERNEL_ROW = { id: 'topic-live', name: 'x', createdAt: 1, updatedAt: 2 }
/** 收窄重试参数，避免用例真的等 6 × 700ms。 */
const FAST = { attempts: 3, delayMs: 1 }

async function load(): Promise<typeof TopicBranchModule> {
  vi.resetModules()
  return await import('../topicBranch')
}

function stubGet(get: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  ;(window as unknown as { api: unknown }).api = { dshTopicGet: get, dshTopicList: vi.fn() }
  return get
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('kernelKnowsTopic（启动窗口重试）', () => {
  it('验C-1：第一次拿不到、随后成功 → 判为"内核认识"，不误判', async () => {
    const get = stubGet(
      vi.fn().mockRejectedValueOnce(new Error('No handler registered')).mockResolvedValue({ topic: KERNEL_ROW })
    )
    const { kernelKnowsTopic } = await load()

    await expect(kernelKnowsTopic('topic-live', FAST)).resolves.toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('验C-2：内核明确回答"无此行" → **只问一次、不重试**（确定性否定不得拖满重试）', async () => {
    // 这条是本项最容易写错的地方：把 `topic === undefined` 也当成"暂时没问到"去重试，
    // 只会让每一次对已删话题的发送都白等 6 × 700ms。
    const get = stubGet(vi.fn().mockResolvedValue({}))
    const { kernelKnowsTopic } = await load()

    await expect(kernelKnowsTopic('topic-gone', FAST)).resolves.toBe(false)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('验C-3：全部尝试耗尽 → 返回 null（三值语义不变，仍是"不知道"）', async () => {
    const get = stubGet(vi.fn().mockRejectedValue(new Error('ipc down')))
    const { kernelKnowsTopic } = await load()

    await expect(kernelKnowsTopic('topic-x', FAST)).resolves.toBeNull()
    expect(get).toHaveBeenCalledTimes(FAST.attempts)
  })

  it('验C-5：成功路径不引入固定延迟——不推进任何定时器也要能返回', async () => {
    // 若实现里存在"无条件先 sleep"，这条会挂到用例超时（红），而耗时断言这种弱信号发现不了它。
    stubGet(vi.fn().mockResolvedValue({ topic: KERNEL_ROW }))
    const { kernelKnowsTopic } = await load()

    vi.useFakeTimers()
    try {
      await expect(kernelKnowsTopic('topic-live', FAST)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
