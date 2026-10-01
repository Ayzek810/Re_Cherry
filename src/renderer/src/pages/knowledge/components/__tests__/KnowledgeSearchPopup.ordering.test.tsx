/**
 * 二轮审查 f2-18：知识库检索无并发/乱序保护——慢的旧查询会覆盖新查询的结果。
 *
 * 缺陷形态：`handleSearch` 没有 requestId / 取消，`await searchKnowledgeBase(...)` 的 resolve 直接
 * `setResults`。依次回车检索 "A" 再 "B" 时，若 A 的响应后到，`results` 会变成 A 的命中，而
 * `searchKeyword` 已是 "B"（同步更新）——高亮关键词与结果内容错位，用户把不相关片段当成 B 的结果。
 *
 * 行为级断言：先发 A（慢）再发 B（快），B 先回、A 后回；最终列表必须是 B 的命中，且 loading 已收。
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
  List: ({ dataSource }: { dataSource: Array<{ pageContent: string }> }) => (
    <div data-testid="result-list" data-count={dataSource.length} data-first={dataSource[0]?.pageContent ?? ''} />
  ),
  Modal: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Spin: () => <div data-testid="spin" />
}))

import KnowledgeSearchPopup from '../KnowledgeSearchPopup'

const base = { id: 'base-1', name: 'Demo' } as KnowledgeBase

function renderPopup() {
  show.mockClear()
  void KnowledgeSearchPopup.show({ base })
  const element = show.mock.calls[0][0] as React.ReactElement
  return render(element)
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('KnowledgeSearchPopup 检索乱序守卫（f2-18）', () => {
  beforeEach(() => {
    searchKnowledgeBase.mockReset()
    ;(window as unknown as { toast: unknown }).toast = {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    }
  })

  it('慢的旧查询后到不得覆盖新查询结果', async () => {
    const slow = deferred<Array<{ pageContent: string; score: number; metadata: object; file: null }>>()
    const fast = deferred<Array<{ pageContent: string; score: number; metadata: object; file: null }>>()
    searchKnowledgeBase.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    renderPopup()
    const input = screen.getByTestId('search-input')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'alpha' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await act(async () => {
      fireEvent.change(input, { target: { value: 'beta' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    // 新查询先回。
    await act(async () => {
      fast.resolve([{ pageContent: 'beta hit', score: 0.9, metadata: {}, file: null }])
    })
    // 旧查询后回——必须被丢弃。
    await act(async () => {
      slow.resolve([{ pageContent: 'alpha hit', score: 0.8, metadata: {}, file: null }])
    })

    await waitFor(() => {
      expect(screen.getByTestId('result-list').dataset.first).toBe('beta hit')
    })
    expect(screen.getByTestId('result-list').dataset.count).toBe('1')
    expect(screen.queryByTestId('spin')).toBeNull()
  })
})
