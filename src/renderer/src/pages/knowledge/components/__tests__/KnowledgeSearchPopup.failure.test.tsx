/**
 * 二轮审查 f2-13：知识库检索失败被渲染成"没有结果"。
 *
 * 缺陷形态：`knowledgeBaseApi.searchKnowledgeBase` 自己吞掉异常并 `return []`，于是弹窗的 catch
 * **不可达**，渲染面只有 `loading ? <Spin/> : <List dataSource={results}/>` 二分——检索失败（模型未
 * 配置、库文件损坏、向量维度不符）时用户看到的是一个安静的空列表框，会直接得出"知识库里没有相关
 * 内容"的错误结论（CLAUDE.md §9「A failure must never look like an empty result」）。
 *
 * 行为级断言：
 *   ① 检索失败 → 渲染显式错误态 + 重试按钮，并弹 toast.error（不是空列表）；
 *   ② 检索成功但 0 命中 → 渲染空态（与失败态区分开）；
 *   ③ 重试成功后渲染结果列表。
 */
import '@renderer/i18n'

import type { KnowledgeBase } from '@renderer/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { searchKnowledgeBase, show } = vi.hoisted(() => ({
  searchKnowledgeBase: vi.fn(),
  show: vi.fn()
}))

vi.mock('@renderer/services/knowledgeBaseApi', () => ({ searchKnowledgeBase }))

vi.mock('@renderer/components/TopView', () => ({ TopView: { show, hide: vi.fn() } }))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('../KnowledgeSearchItem', () => ({
  default: ({ item }: { item: { pageContent: string } }) => <div data-testid="search-hit">{item.pageContent}</div>
}))

vi.mock('lucide-react', () => ({ Search: () => <span /> }))

// antd 替身：Input 换成原生 input（Enter 的按下即检索），List 用 testid 暴露渲染条数。
vi.mock('antd', () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  Divider: () => <hr />,
  Empty: ({ description }: { description?: React.ReactNode }) => <div data-testid="empty-state">{description}</div>,
  Input: ({
    value,
    onChange,
    onPressEnter
  }: {
    value?: string
    onChange?: (event: { target: { value: string } }) => void
    onPressEnter?: () => void
  }) => (
    <input
      data-testid="search-input"
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onPressEnter?.()
      }}
    />
  ),
  List: ({ dataSource }: { dataSource: unknown[] }) => <div data-testid="result-list" data-count={dataSource.length} />,
  Modal: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Spin: () => <div data-testid="spin" />
}))

import KnowledgeSearchPopup from '../KnowledgeSearchPopup'

const base = { id: 'base-1', name: 'Demo' } as KnowledgeBase
const toastError = vi.fn()

/** 用 TopView.show 捕获到的元素渲染真实弹窗内容（不 mock 弹窗自身逻辑）。 */
function renderPopup() {
  show.mockClear()
  void KnowledgeSearchPopup.show({ base })
  const element = show.mock.calls[0][0] as React.ReactElement
  return render(element)
}

function searchFor(text: string) {
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: text } })
  fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Enter' })
}

describe('KnowledgeSearchPopup 检索失败语义（f2-13）', () => {
  beforeEach(() => {
    searchKnowledgeBase.mockReset()
    toastError.mockReset()
    ;(window as unknown as { toast: unknown }).toast = {
      error: toastError,
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    }
  })

  it('检索失败：显式错误态 + 重试按钮 + toast，而不是空列表', async () => {
    searchKnowledgeBase.mockRejectedValueOnce(new Error('embedding model unavailable'))

    renderPopup()
    await act(async () => {
      searchFor('kernel')
    })

    const errorState = await screen.findByTestId('knowledge-search-error')
    expect(errorState).toHaveTextContent('Knowledge base search failed. Retry.')
    expect(errorState.querySelector('button')).not.toBeNull()
    expect(screen.queryByTestId('result-list')).toBeNull()
    expect(screen.queryByTestId('empty-state')).toBeNull()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('检索成功但 0 命中：渲染空态（与失败态区分）', async () => {
    searchKnowledgeBase.mockResolvedValueOnce([])

    renderPopup()
    await act(async () => {
      searchFor('kernel')
    })

    expect(await screen.findByTestId('empty-state')).toHaveTextContent('No matching content found')
    expect(screen.queryByTestId('knowledge-search-error')).toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('重试成功后渲染结果列表', async () => {
    searchKnowledgeBase
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce([{ pageContent: 'hit one', score: 0.9, metadata: {}, file: null }])

    renderPopup()
    await act(async () => {
      searchFor('kernel')
    })
    const errorState = await screen.findByTestId('knowledge-search-error')

    await act(async () => {
      fireEvent.click(errorState.querySelector('button') as HTMLButtonElement)
    })

    await waitFor(() => {
      expect(screen.getByTestId('result-list').dataset.count).toBe('1')
    })
    expect(screen.queryByTestId('knowledge-search-error')).toBeNull()
  })
})
