/**
 * 按话题中止源的单元测试。
 *
 * 存在理由（真机取证，见 topicWorkAbort.ts 模块注释）：内核的 topic stop **不中断在途工具**，
 * 所以「暂停」必须由 fork 自己掌握一条中止源。本文件钉住这条源的语义：
 * 登记 / 注销 / 按话题中止 / 只中止该话题 / 幂等。
 */
import { describe, expect, it } from 'vitest'

import { abortTopicWork, registerTopicWork, topicWorkCount } from '../topicWorkAbort'

describe('topicWorkAbort（按话题的在途中止源）', () => {
  it('中止该话题登记的全部在途工作，并把原因交给被中止方', () => {
    const a = new AbortController()
    const b = new AbortController()
    const offA = registerTopicWork('topic-1', a)
    const offB = registerTopicWork('topic-1', b)

    const reason = new Error('paused by user')
    expect(topicWorkCount('topic-1')).toBe(2)

    expect(abortTopicWork('topic-1', reason)).toBe(2)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(a.signal.reason).toBe(reason)

    offA()
    offB()
    expect(topicWorkCount('topic-1')).toBe(0)
  })

  it('只中止自己的话题：别的话题在途工作不受影响', () => {
    const mine = new AbortController()
    const other = new AbortController()
    const offMine = registerTopicWork('topic-mine', mine)
    const offOther = registerTopicWork('topic-other', other)

    expect(abortTopicWork('topic-mine')).toBe(1)
    expect(mine.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)

    offMine()
    offOther()
  })

  it('注销后不再被中止（工作已结束就不该再收到中止）', () => {
    const controller = new AbortController()
    const off = registerTopicWork('topic-2', controller)
    off()

    expect(abortTopicWork('topic-2')).toBe(0)
    expect(controller.signal.aborted).toBe(false)
    expect(topicWorkCount('topic-2')).toBe(0)
  })

  it('幂等：已中止的不再计数，重复调用返回 0', () => {
    const controller = new AbortController()
    const off = registerTopicWork('topic-3', controller)

    expect(abortTopicWork('topic-3')).toBe(1)
    expect(abortTopicWork('topic-3')).toBe(0)
    expect(controller.signal.aborted).toBe(true)

    off()
  })

  it('没有登记的话题：中止是 no-op 且返回 0', () => {
    expect(abortTopicWork('topic-none')).toBe(0)
  })
})
