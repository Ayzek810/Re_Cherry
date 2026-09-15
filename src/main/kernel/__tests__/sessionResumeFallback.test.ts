import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'

import { type ResumeOrCreateOptions, resumeOrCreateSession } from '../sessionResumeFallback'

/**
 * v0.3.0-2 目标 A（`report.md` §2.4 的验A-2 / 验A-3 / 验A-4）。
 *
 * 这里守的是一条**数据安全**边界：resume 失败后是否允许用同一 id 新建空会话。判错的方向有代价——
 * 把"读不出来"当成"不存在"，就可能在一个已有日志的 id 上 `create()`，最坏情况覆盖用户历史。
 *
 * 判据是**持久化里有没有这个会话**（`listPersisted()`），不是 resume 抛了哪种错误——所以第 2、3
 * 两条用例把同一个错误形态（普通 `Error`）分别配上"库里有"/"库里没有"，结论必须相反。
 *
 * 信号效力边界（如实记账）：以下用桩，**不证明**真机 `agents.create` 在已有日志 id 上的行为
 * （覆盖还是拒绝，上游语义未验证）；本次修法的目的正是让这条路径**进不去**，因此不需要那个实验。
 */
const SESSION_ID = SessionId('topic-1')
const TOPIC_ID = 'topic-1'

/** 桩：句柄身份固定，只统计 `createFresh` 被调用了多少次。 */
function harness(overrides: Partial<ResumeOrCreateOptions>): {
  options: ResumeOrCreateOptions
  handle: AgentHandle
  createCount: () => number
} {
  const handle = { agent: { id: 'stub-agent' } } as unknown as AgentHandle
  let created = 0
  const options: ResumeOrCreateOptions = {
    sessionId: SESSION_ID,
    topicId: TOPIC_ID,
    listPersisted: () => Promise.resolve([]),
    resume: () => Promise.resolve(handle),
    createFresh: () => {
      created += 1
      return Promise.resolve(handle)
    },
    ...overrides
  }
  return { options, handle, createCount: () => created }
}

describe('resumeOrCreateSession（resume 失败后的唯一处置点）', () => {
  it('正常路径：resume 成功即返回，且**完全不查库**（不引入热路径开销）', async () => {
    let listed = 0
    const { options, handle, createCount } = harness({
      listPersisted: () => {
        listed += 1
        return Promise.resolve([])
      }
    })

    await expect(resumeOrCreateSession(options)).resolves.toBe(handle)
    expect(listed).toBe(0)
    expect(createCount()).toBe(0)
  })

  it('验A-2：库里有该会话（读不出来）→ 原样抛出 resume 的错误，且**不新建**', async () => {
    const cause = new SessionFormatUnsupportedError(
      'session "topic-1" contains event type "cherry/work-mode" (seq 0) unknown to this harness and not marked ignorable'
    )
    const { options, createCount } = harness({
      resume: () => Promise.reject(cause),
      listPersisted: () => Promise.resolve([{ id: SESSION_ID }])
    })

    await expect(resumeOrCreateSession(options)).rejects.toBe(cause)
    expect(createCount()).toBe(0)
  })

  it('验A-2 补：错误形态是未知的普通 Error、但库里有该会话 → 同样拒绝（判据不是错误类型）', async () => {
    const cause = new Error('a failure shape this harness has never seen before')
    const { options, createCount } = harness({
      resume: () => Promise.reject(cause),
      listPersisted: () => Promise.resolve([{ id: SESSION_ID }])
    })

    await expect(resumeOrCreateSession(options)).rejects.toBe(cause)
    expect(createCount()).toBe(0)
  })

  it('验A-3：库里没有该会话 → 保留兜底新建（既有健壮性不回归）', async () => {
    const { options, handle, createCount } = harness({
      resume: () => Promise.reject(new Error('session "topic-1" not found')),
      listPersisted: () => Promise.resolve([])
    })

    await expect(resumeOrCreateSession(options)).resolves.toBe(handle)
    expect(createCount()).toBe(1)
  })

  it('验A-4：list() 自身失败 → fail-closed：抛出且**不新建**', async () => {
    const listError = new Error('persistence backend unavailable')
    const { options, createCount } = harness({
      resume: () => Promise.reject(new Error('session "topic-1" not found')),
      listPersisted: () => Promise.reject(listError)
    })

    await expect(resumeOrCreateSession(options)).rejects.toBe(listError)
    expect(createCount()).toBe(0)
  })

  it('库里只有别的会话 → 仍兜底新建（挡住"非空即存在"的写法）', async () => {
    const { options, handle, createCount } = harness({
      resume: () => Promise.reject(new Error('session "topic-1" not found')),
      listPersisted: () => Promise.resolve([{ id: SessionId('topic-2') }])
    })

    await expect(resumeOrCreateSession(options)).resolves.toBe(handle)
    expect(createCount()).toBe(1)
  })
})
