import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'

import { isUnreadableSessionError } from '../sessionReadFailure'

/**
 * 这个判别守的是一条**数据安全**边界：resume 失败后是否允许用同一 id 新建空会话。
 * 判错的方向是有代价的——把"读不出来"误判成"不存在"，就可能覆盖用户历史。
 */
describe('isUnreadableSessionError', () => {
  it('把「格式不受支持」判为不可读', () => {
    const error = new SessionFormatUnsupportedError(
      'session "x" contains event type "cherry/work-mode" (seq 0) unknown to this harness and not marked ignorable'
    )
    expect(isUnreadableSessionError(error)).toBe(true)
  })

  it('把「日志损坏」判为不可读', () => {
    expect(
      isUnreadableSessionError(
        new SessionPersistenceCorruptionError('stored event ignorable must be 0, 1, or null', {})
      )
    ).toBe(true)
  })

  it('把「会话不存在」判为可新建（dsh 对它抛的是普通 Error，没有类型化 code）', () => {
    expect(isUnreadableSessionError(new Error('session "x" not found'))).toBe(false)
  })

  it('对非 Error 值返回 false，不抛错', () => {
    expect(isUnreadableSessionError(undefined)).toBe(false)
    expect(isUnreadableSessionError(null)).toBe(false)
    expect(isUnreadableSessionError('boom')).toBe(false)
    expect(isUnreadableSessionError({ name: 'SessionFormatUnsupportedError' })).toBe(false)
  })
})
