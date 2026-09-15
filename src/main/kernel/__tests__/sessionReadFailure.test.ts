import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'

import { classifySessionReadFailure } from '../sessionReadFailure'

/**
 * 这是**诊断分类器**，不是安全门控。
 *
 * 是否允许"resume 失败后用同一 id 新建会话"，由 `sessionResumeFallback.ts` 的持久化存在性查询
 * （`ctx.sessionPersistence.list()`）决定——判据是本机事实，不依赖上游抛错行为（上游无格式兼容
 * 承诺，靠错误分类会无声失效）。本分类只用于把故障形态写进日志（v0.3.0-2 目标 A，`report.md` §2.3）。
 * 因此这里测的是"三类分得开"，而不是"哪些错误允许新建"。
 */
describe('classifySessionReadFailure（诊断分类，不参与新建决策）', () => {
  it('把「格式不受支持」单独归一类', () => {
    const error = new SessionFormatUnsupportedError(
      'session "x" contains event type "cherry/work-mode" (seq 0) unknown to this harness and not marked ignorable'
    )
    expect(classifySessionReadFailure(error)).toBe('format-unsupported')
  })

  it('把「日志损坏」单独归一类（与格式不受支持分开，便于真机判形态）', () => {
    const error = new SessionPersistenceCorruptionError('stored event ignorable must be 0, 1, or null', {})
    expect(classifySessionReadFailure(error)).toBe('corrupted')
  })

  it('「会话不存在」是 unclassified（dsh 对它抛普通 Error，没有类型化 code）', () => {
    expect(classifySessionReadFailure(new Error('session "x" not found'))).toBe('unclassified')
  })

  it('非 Error 值不抛错，一律 unclassified（含仅有同名 name 的普通对象，挡住"按 name 判"的将来改动）', () => {
    expect(classifySessionReadFailure(undefined)).toBe('unclassified')
    expect(classifySessionReadFailure(null)).toBe('unclassified')
    expect(classifySessionReadFailure('boom')).toBe('unclassified')
    expect(classifySessionReadFailure({ name: 'SessionFormatUnsupportedError' })).toBe('unclassified')
  })
})
