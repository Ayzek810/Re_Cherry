/**
 * `Dsh_SearchMessages` 是渲染层唯一一个既无 boot 窗口重试、也无 catch 的内核查询。
 *
 * 缺陷形态：`const { hits } = await window.api.dshSearchMessages(...)` 直调，`setIsLoading(false)`
 * 只在成功路径执行。主进程 handler 要等 `initTopics()` 之后才注册，启动窗口内会以
 * "No handler registered" 拒绝。失败后果比"空结果"更糟：`Spin spinning` 永久转圈，而结果 `List` 被
 * `opacity: 0`（`isLoading ? 0 : 1`）永久置为全透明 → 面板同时"转圈 + 看不见"。
 *
 * 行为级断言：
 *   ① 首次拒绝、之后成功 → 仍拿到结果（重试生效，不是一次就放弃）；
 *   ② 全部尝试都没问到 → 渲染显式错误态 + 重试按钮，且列表不再被 `opacity: 0` 藏起来。
 */
import '@renderer/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ containerRef: { current: null }, handleScroll: () => {} })
}))

// antd 替身：本测试只关心"失败是否可见"，不需要真实布局。
vi.mock('antd', () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  List: ({ dataSource, style }: { dataSource: unknown[]; style?: React.CSSProperties }) => (
    <div data-testid="result-list" data-opacity={String(style?.opacity ?? 1)} data-count={dataSource.length} />
  ),
  Segmented: () => <div data-testid="segmented" />,
  Spin: ({ children }: { children?: React.ReactNode }) => <div data-testid="spin">{children}</div>,
  Typography: {
    Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    Title: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>
  }
}))

import SearchResults from '../SearchResults'

const dshSearchMessages = vi.fn()
const toastError = vi.fn()

function hit(seq: number) {
  return {
    topicId: 'topic-1',
    topicName: 'Topic 1',
    seq,
    role: 'assistant' as const,
    createdAt: 1_700_000_000_000 + seq,
    text: `kernel answer ${seq}`
  }
}

describe('SearchResults 内核检索的失败语义', () => {
  beforeEach(() => {
    dshSearchMessages.mockReset()
    toastError.mockReset()
    ;(window as unknown as { api: unknown }).api = { dshSearchMessages }
    ;(window as unknown as { toast: unknown }).toast = {
      error: toastError,
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次拒绝后重试成功：结果照常渲染（boot 窗口不算终局失败）', async () => {
    dshSearchMessages.mockRejectedValueOnce(new Error('No handler registered')).mockResolvedValue({ hits: [hit(1)] })

    render(<SearchResults keywords="kernel" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)

    await waitFor(
      () => {
        expect(dshSearchMessages).toHaveBeenCalledTimes(2)
      },
      { timeout: 10_000 }
    )

    await waitFor(() => {
      expect(screen.getByTestId('result-list').dataset.count).toBe('1')
    })
    expect(screen.queryByTestId('history-search-error')).toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('全部尝试都没问到：渲染错误态 + 重试按钮，列表不再被 opacity:0 藏起来', async () => {
    dshSearchMessages.mockRejectedValue(new Error('kernel not booted'))

    render(<SearchResults keywords="kernel" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)

    const errorState = await screen.findByTestId('history-search-error', {}, { timeout: 15_000 })
    // 真实 i18n 已合并两语键：断言渲染出的是文案而不是 key 本身。
    expect(errorState).toHaveTextContent('Failed to search messages. Retry.')
    expect(errorState.querySelector('button')).not.toBeNull()
    // 失败后必须解除 opacity:0——旧实现在这条路径上永远停在"转圈 + 全透明"。
    expect(screen.getByTestId('result-list').dataset.opacity).toBe('1')
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
