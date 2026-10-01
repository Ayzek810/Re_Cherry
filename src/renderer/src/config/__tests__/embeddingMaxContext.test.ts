import { describe, expect, it } from 'vitest'

import { EMBEDDING_MODELS, getEmbeddingMaxContext } from '../embedings'

/**
 * r2-82 行为契约：
 * 1. `voyage-code-3` 在表里只出现一次（原先四条 1024/256/512/2048，`.find` 只能取首条，
 *    后三条是死数据）；
 * 2. 未命中必须与「有上限」可区分 —— 返回 `null`，不再返回 `undefined` 让调用方
 *    `if (!value || !maxContext || …)` 把「没有答案」当成「没有上限」。
 */
describe('getEmbeddingMaxContext (r2-82)', () => {
  it('keeps exactly one entry per embedding id', () => {
    const ids = EMBEDDING_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => id === 'voyage-code-3')).toHaveLength(1)
  })

  it('returns the single voyage-code-3 limit instead of the first duplicate', () => {
    expect(getEmbeddingMaxContext('voyage-code-3')).toBe(1024)
  })

  it('still returns the sibling voyage limits', () => {
    expect(getEmbeddingMaxContext('voyage-3-large')).toBe(2048)
    expect(getEmbeddingMaxContext('voyage-3')).toBe(1024)
    expect(getEmbeddingMaxContext('voyage-3-lite')).toBe(512)
  })

  it('keeps the bge fallbacks', () => {
    expect(getEmbeddingMaxContext('bge-large-zh-v1.5')).toBe(512)
    expect(getEmbeddingMaxContext('bge-m3')).toBe(8000)
  })

  it('returns null (no answer) — not undefined — for an unknown id', () => {
    const result = getEmbeddingMaxContext('totally-unknown-embedding')
    expect(result).toBeNull()
    expect(result).not.toBeUndefined()
  })
})
