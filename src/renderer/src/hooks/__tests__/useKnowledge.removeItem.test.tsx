/**
 * 二轮审查 f2-14：知识库条目删除是纯乐观写——失败不回滚、无 toast，六处调用点全部丢弃 Promise。
 *
 * 缺陷形态（CLAUDE.md §9「A deletion returns `Promise<boolean>`. Restore optimistic rows on failure and
 * show `toast.error`」）：`removeItem` 先 `dispatch(removeItemAction)` 摘掉 redux 行，随后裸
 * `await knowledgeBaseApi.remove(...)`；向量库删失败时行不会恢复（刷新后条目仍不在列表里但向量还占
 * 着），而 `onClick={() => removeItem(item)}` 把 Promise 交给 React——失败只是未处理的 rejection，
 * 磁盘与 UI 都没有任何信号。
 *
 * 行为级断言：
 *   ① 成功 → 返回 true，行被摘掉；
 *   ② 向量库删失败 → 返回 false，redux 行**精确还原**（含原数组位置），并弹 toast.error；
 *   ③ 本地文件清理失败 → 索引删除仍算成功，但必须给出可见信号（孤儿文件不得静默）。
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type { KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { remove, deleteFiles } = vi.hoisted(() => ({
  remove: vi.fn(),
  deleteFiles: vi.fn()
}))

vi.mock('@renderer/services/knowledgeBaseApi', () => ({
  knowledgeBaseApi: { remove },
  // `enqueueItem` 的既有依赖（本测试不走处理链，仅供模块解析）。
  getEmbeddingRef: vi.fn()
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: { deleteFiles }
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistants: () => ({ assistants: [], updateAssistants: vi.fn() })
}))

import knowledgeReducer from '@renderer/store/knowledge'

import { useKnowledge } from '../useKnowledge'

const baseId = 'base-1'

function note(id: string, content: string): KnowledgeItem {
  return { id, type: 'note', content, created_at: 1, updated_at: 1 } as KnowledgeItem
}

const items = [note('n-1', 'first'), note('n-2', 'second'), note('n-3', 'third')]

function makeStore() {
  return configureStore({
    reducer: combineReducers({ knowledge: knowledgeReducer }),
    preloadedState: {
      knowledge: {
        bases: [
          {
            id: baseId,
            name: 'Demo',
            items: items.map((item) => ({ ...item })),
            created_at: 1,
            updated_at: 1
          } as unknown as KnowledgeBase
        ]
      }
    }
  })
}

function wrapperFor(store: ReturnType<typeof makeStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>
}

const toast = { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() }

describe('useKnowledge.removeItem（f2-14：乐观写必须可回滚 + 可见）', () => {
  beforeEach(() => {
    remove.mockReset()
    deleteFiles.mockReset()
    toast.error.mockReset()
    toast.warning.mockReset()
    ;(window as unknown as { toast: unknown }).toast = toast
  })

  it('成功：返回 true 且条目从库中摘除', async () => {
    remove.mockResolvedValue(undefined)
    const store = makeStore()
    const { result } = renderHook(() => useKnowledge(baseId), { wrapper: wrapperFor(store) })
    const target = { ...note('n-2', 'second'), uniqueId: 'u-2' }

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.removeItem(target)
    })

    expect(ok).toBe(true)
    expect(store.getState().knowledge.bases[0].items.map((item) => item.id)).toEqual(['n-1', 'n-3'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('向量库删除失败：返回 false、行精确还原（含位置）并弹 toast.error', async () => {
    remove.mockRejectedValue(new Error('vector store unavailable'))
    const store = makeStore()
    const { result } = renderHook(() => useKnowledge(baseId), { wrapper: wrapperFor(store) })
    const target = { ...note('n-2', 'second'), uniqueId: 'u-2' }

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.removeItem(target)
    })

    expect(ok).toBe(false)
    // 精确还原：位置、id、全部字段都与删除前一致（不是"重新 append 到末尾"）。
    expect(store.getState().knowledge.bases[0].items.map((item) => item.id)).toEqual(['n-1', 'n-2', 'n-3'])
    expect(store.getState().knowledge.bases[0].items[1]).toEqual(items[1])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error.mock.calls[0][0]).toBe('Delete failed. The entry was restored.')
  })

  it('本地文件清理失败：索引删除仍算成功，但给出可见警告（孤儿文件不得静默）', async () => {
    remove.mockResolvedValue(undefined)
    deleteFiles.mockRejectedValue(new Error('file locked'))
    const store = makeStore()
    const { result } = renderHook(() => useKnowledge(baseId), { wrapper: wrapperFor(store) })
    const target = {
      ...note('n-2', 'second'),
      uniqueId: 'u-2',
      type: 'file',
      content: { id: 'file-1', path: '/tmp/a.pdf' }
    } as unknown as KnowledgeItem

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.removeItem(target)
    })

    expect(ok).toBe(true)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    expect(toast.warning.mock.calls[0][0]).toBe('The index entry was deleted, but local files were not cleaned up.')
    expect(toast.error).not.toHaveBeenCalled()
  })
})
