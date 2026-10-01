/**
 * 知识库条目删除是纯乐观写——失败不回滚、无 toast，六处调用点全部丢弃 Promise。
 *
 * 缺陷形态：`removeItem` 先 `dispatch(removeItemAction)` 摘掉 redux 行，随后裸
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

const { remove, deleteBase, deleteFiles, assistantsState } = vi.hoisted(() => ({
  remove: vi.fn(),
  deleteBase: vi.fn(),
  deleteFiles: vi.fn(),
  assistantsState: { list: [] as unknown[], updateAssistants: vi.fn() }
}))

vi.mock('@renderer/services/knowledgeBaseApi', () => ({
  knowledgeBaseApi: { remove, delete: deleteBase },
  // `enqueueItem` 的既有依赖（本测试不走处理链，仅供模块解析）。
  getEmbeddingRef: vi.fn()
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: { deleteFiles }
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistants: () => ({ assistants: assistantsState.list, updateAssistants: assistantsState.updateAssistants })
}))

import knowledgeReducer from '@renderer/store/knowledge'

import { useKnowledge, useKnowledgeBases } from '../useKnowledge'

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

describe('useKnowledge.removeItem（乐观写必须可回滚 + 可见）', () => {
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

/**
 * （整库一半）：`deleteKnowledgeBase` 旧实现返回 void、只乐观派发 `deleteBase`，
 * 真实删除由 reducer 内的 fire-and-forget IPC 承担（失败只 warn）——失败时界面显示「删成功」，
 * 调用点也拿不到任何可判断的返回值。现在返回 `Promise<boolean>`，失败时 redux 一行都不动
 * 并弹 `toast.error`。
 *
 * 行为级断言：
 *   ① 成功 → true，库从 redux 摘除，助手引用被清理；
 *   ② 真实删除失败 → false，库**仍在**（未做乐观删除，因此无需回滚），弹 toast.error；
 *   ③ 未知 baseId → false，且不发起删除。
 */
describe('useKnowledgeBases.deleteKnowledgeBase（整库删除必须可判成败 + 可见）', () => {
  beforeEach(() => {
    deleteBase.mockReset()
    assistantsState.list = []
    assistantsState.updateAssistants.mockReset()
    toast.error.mockReset()
    ;(window as unknown as { toast: unknown }).toast = toast
  })

  it('成功：返回 true、库从 redux 摘除、助手引用被清理', async () => {
    deleteBase.mockResolvedValue(undefined)
    assistantsState.list = [{ id: 'as-1', knowledge_bases: [{ id: baseId }, { id: 'other' }] }]
    const store = makeStore()
    const { result } = renderHook(() => useKnowledgeBases(), { wrapper: wrapperFor(store) })

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteKnowledgeBase(baseId)
    })

    expect(ok).toBe(true)
    expect(store.getState().knowledge.bases).toHaveLength(0)
    expect(assistantsState.updateAssistants).toHaveBeenCalledTimes(1)
    const updated = assistantsState.updateAssistants.mock.calls[0][0] as { knowledge_bases: { id: string }[] }[]
    expect(updated[0].knowledge_bases.map((kb) => kb.id)).toEqual(['other'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('真实删除失败：返回 false、库仍在（未乐观删，无需回滚）并弹 toast.error', async () => {
    deleteBase.mockRejectedValue(new Error('vector store locked'))
    const store = makeStore()
    const { result } = renderHook(() => useKnowledgeBases(), { wrapper: wrapperFor(store) })

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteKnowledgeBase(baseId)
    })

    expect(ok).toBe(false)
    expect(store.getState().knowledge.bases.map((b) => b.id)).toEqual([baseId])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error.mock.calls[0][0]).toBe('Failed to delete the knowledge base.')
    expect(assistantsState.updateAssistants).not.toHaveBeenCalled()
  })

  it('未知 baseId：返回 false 且不发起删除', async () => {
    const store = makeStore()
    const { result } = renderHook(() => useKnowledgeBases(), { wrapper: wrapperFor(store) })

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteKnowledgeBase('nope')
    })

    expect(ok).toBe(false)
    expect(deleteBase).not.toHaveBeenCalled()
  })
})
