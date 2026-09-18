import { describe, expect, it } from 'vitest'

import { isTopicNotFoundError } from '../topicNotFoundError'

/**
 * Dsh_TopicEvents 对确定性"注册表无此行"按空会话回答的判定钉：
 *
 * ① openTopic 的形状必须命中（否则 not-found 噪音回归）；
 * ② 相邻的确定性形状（fork/锚点）必须**不**命中——它们各有各的调用语义，
 *   在 events 通道吞掉它们属于越权；
 * ③ 瞬时失败必须**不**命中——渲染层的重试窗口靠 reject 传递"暂时不知道"，
 *   吞掉它等于把"不知道"伪装成"空会话"（与 retryKernelQuery 的语义契约相反）。
 */
describe('isTopicNotFoundError（确定性"注册表无此行"判定，主进程侧）', () => {
  it('openTopic 的确定性形状 → true', () => {
    expect(isTopicNotFoundError(new Error('kernel: topic "a6b92515-78f5-4ac6-b0a0-947190d134ea" not found'))).toBe(true)
    expect(isTopicNotFoundError(new Error('kernel: topic "x" not found'))).toBe(true)
  })

  it('fork / 锚点系的相邻确定性形状 → false（不越权吞别的通道语义）', () => {
    expect(isTopicNotFoundError(new Error('kernel: source topic "x" not found'))).toBe(false)
    expect(isTopicNotFoundError(new Error('kernel: user message seq 3 not found in "x"'))).toBe(false)
    expect(
      isTopicNotFoundError(new Error('kernel: anchor user seq 3 not found in "x" (stale view, refresh first)'))
    ).toBe(false)
  })

  it('瞬时失败形状 → false（渲染层重试窗口必须仍能收到它们）', () => {
    expect(isTopicNotFoundError(new Error('session is not loaded'))).toBe(false)
    expect(isTopicNotFoundError(new Error('kernel: topic registry unavailable'))).toBe(false)
    expect(isTopicNotFoundError(new Error('kernel: topic "x" was not found in registry'))).toBe(false)
  })

  it('消息形状边界（前后缀/空 id）与非 Error 输入 → false，不抛', () => {
    // 前后缀混入 = 别的错误在引述这个话题，不是 openTopic 的原样抛出
    expect(isTopicNotFoundError(new Error('failed: kernel: topic "x" not found'))).toBe(false)
    expect(isTopicNotFoundError(new Error('kernel: topic "x" not found (foo)'))).toBe(false)
    expect(isTopicNotFoundError(new Error('kernel: topic "" not found'))).toBe(false)
    expect(isTopicNotFoundError(null)).toBe(false)
    expect(isTopicNotFoundError(undefined)).toBe(false)
    expect(isTopicNotFoundError('kernel: topic "x" not found')).toBe(false)
  })
})
