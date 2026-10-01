/**
 * 二轮审查 f2-15：绘画历史加载失败 → 永久转圈的空缩略条。
 *
 * 缺陷形态：`loadPage` 的 catch 只写日志——`items` 保持 `[]`、`hasMore` 保持 `true`。
 * `PaintingStrip` 消费侧是 `{hasMore && <Loader2 className="animate-spin" />}`，于是
 * Dexie 打不开/读失败时用户看到的是**一个永远转的 Loader + 空条**，既不能判断"真的没有历史"
 * 也不能判断"读失败了"，也无法重试。`isLoading` 被 return 却全仓库无人消费。
 *
 * 行为级断言：
 *   ① 失败时 `hasMore` 必须为 false（否则缩略条永久 spinner）；
 *   ② 失败时必须有 `error`（UI 据此渲染错误态，且与"没有历史"分离）；
 *   ③ `retry()` 清错并重跑首页，成功后可恢复常规分页；
 *   ④ 成功且满页时 `hasMore` 为 true（不破坏正常分页）。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 被提升到文件顶部，工厂里只能引用 vi.hoisted 的值。
const { toArray, orderBy, where } = vi.hoisted(() => {
  const toArray = vi.fn()
  const limit = vi.fn(() => ({ toArray }))
  const reverse = vi.fn(() => ({ limit }))
  const below = vi.fn(() => ({ reverse }))
  const orderBy = vi.fn(() => ({ reverse, limit }))
  const where = vi.fn(() => ({ below }))
  return { toArray, orderBy, where }
})

vi.mock('@renderer/databases', () => ({
  db: {
    paintings: { orderBy, where }
  }
}))

import { usePaintingHistory } from '../usePaintingHistory'

function row(index: number) {
  return { id: `p-${index}`, createdAt: 1_000 - index }
}

describe('usePaintingHistory（f2-15：失败不得停成永久转圈）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('读失败：hasMore 置 false、error 置位（不再永久转圈）', async () => {
    toArray.mockRejectedValueOnce(new Error('IndexedDB open failed'))

    const { result } = renderHook(() => usePaintingHistory())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('IndexedDB open failed')
    // 关键断言：不置 false 就是缩略条那个"永远转"的 Loader。
    expect(result.current.hasMore).toBe(false)
    expect(result.current.items).toEqual([])
  })

  it('失败后 retry()：清掉错误态并重跑首页，成功即恢复分页', async () => {
    toArray.mockRejectedValueOnce(new Error('transient read failure'))

    const { result } = renderHook(() => usePaintingHistory())
    // 先等第一次装载彻底落定（loadingRef 也归位），否则 retry 会被在途守卫直接丢掉。
    await waitFor(() => {
      expect(result.current.error).not.toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    toArray.mockResolvedValueOnce([])
    act(() => {
      result.current.retry()
    })

    await waitFor(() => {
      expect(result.current.error).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.items).toEqual([])
    // 空页（不足 PAGE_SIZE）→ 确实没有更多。
    expect(result.current.hasMore).toBe(false)
  })

  it('成功且满页：hasMore 保持 true（不破坏正常分页）', async () => {
    toArray.mockResolvedValueOnce(Array.from({ length: 30 }, (_, index) => row(index)))

    const { result } = renderHook(() => usePaintingHistory())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBeNull()
    expect(result.current.hasMore).toBe(true)
    expect(result.current.items).toHaveLength(30)
  })

  it('续页失败同样停掉 hasMore 并暴露 error', async () => {
    toArray.mockResolvedValueOnce(Array.from({ length: 30 }, (_, index) => row(index)))

    const { result } = renderHook(() => usePaintingHistory())
    await waitFor(() => {
      expect(result.current.hasMore).toBe(true)
    })

    toArray.mockRejectedValueOnce(new Error('page 2 read failed'))
    act(() => {
      result.current.loadMore()
    })

    await waitFor(() => {
      expect(result.current.error).not.toBeNull()
    })
    expect(result.current.hasMore).toBe(false)
    // 已载入的第一页不被失败清空（stale-while-error）。
    expect(result.current.items).toHaveLength(30)
  })
})
