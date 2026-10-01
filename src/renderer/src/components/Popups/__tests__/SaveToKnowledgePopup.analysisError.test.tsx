/**
 * c2-12 / c2-24 行为测试：保存到知识库弹窗。
 *
 * c2-12 原状：分析抛错时 catch 里写了一个**全零统计对象**，于是 UI 走「此消息没有可保存的内容」
 * 空态 —— 一个与事实相反的结论，正面违反家规「A failure must never look like an empty result」。
 * c2-24 原状：内容类型行只有 onClick，键盘用户无法勾选，而「保存」的可用性由这些选择决定。
 *
 * antd Modal 换成最小壳：这里钉的是弹窗自己的状态机（错误态 / 重试 / 复选框语义），不是 antd 动画。
 */
import type { MessageContentStats } from '@renderer/utils/knowledge'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SaveToKnowledgePopupContainer } from '../SaveToKnowledgePopup'

const mocks = vi.hoisted(() => ({
  analyzeMessageContent: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@renderer/utils/knowledge', () => ({
  CONTENT_TYPES: {
    TEXT: 'text',
    CODE: 'code',
    THINKING: 'thinking',
    TOOL_USE: 'tools',
    CITATION: 'citations',
    ERROR: 'errors',
    FILE: 'files'
  },
  analyzeMessageContent: mocks.analyzeMessageContent,
  analyzeTopicContent: vi.fn(),
  processMessageContent: vi.fn(() => ({ text: '', files: [] })),
  processTopicContent: vi.fn(() => ({ text: '', files: [] }))
}))

vi.mock('@renderer/hooks/useKnowledge', () => ({
  useKnowledge: () => ({ addNote: vi.fn(), addFiles: vi.fn() }),
  useKnowledgeBases: () => ({ bases: [{ id: 'base-1', name: 'Base', version: '1' }] })
}))

vi.mock('@renderer/components/Tags/CustomTag', () => ({
  default: ({ children }: { children?: ReactNode }) => <span>{children}</span>
}))

vi.mock('@renderer/components/TopView', () => ({ TopView: { show: vi.fn(), hide: vi.fn() } }))

vi.mock('antd', () => {
  interface ModalShellProps {
    open?: boolean
    okButtonProps?: { disabled?: boolean }
    children?: ReactNode
  }
  return {
    Modal: ({ open, okButtonProps, children }: ModalShellProps) => (
      <div data-testid="modal" data-modal-open={String(Boolean(open))}>
        <button type="button" data-testid="modal-ok" disabled={okButtonProps?.disabled}>
          ok
        </button>
        {children}
      </div>
    ),
    Button: ({ children, ...rest }: { children?: ReactNode }) => (
      <button type="button" {...rest}>
        {children}
      </button>
    ),
    Flex: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
    Form: Object.assign(({ children }: { children?: ReactNode }) => <form>{children}</form>, {
      Item: ({ children, label }: { children?: ReactNode; label?: ReactNode }) => (
        <div>
          <span>{label}</span>
          {children}
        </div>
      )
    }),
    Select: () => <div data-testid="select" />,
    Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Typography: { Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }
  }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const fullStats = (overrides: Partial<MessageContentStats> = {}): MessageContentStats => ({
  text: 1,
  code: 0,
  thinking: 0,
  images: 0,
  files: 0,
  tools: 0,
  citations: 0,
  translations: 0,
  errors: 0,
  ...overrides
})

const renderPopup = () =>
  render(<SaveToKnowledgePopupContainer source={{ type: 'message', data: { id: 'm1' } as never }} resolve={vi.fn()} />)

describe('SaveToKnowledgePopup analysis failure (c2-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { toast: unknown }).toast = { error: mocks.toastError, success: vi.fn() }
  })

  it('shows a retryable error state instead of the "no saveable content" empty state', async () => {
    // `analyzeMessageContent` 是同步函数（`utils/knowledge.ts:73`），失败表现为同步抛出。
    mocks.analyzeMessageContent.mockImplementation(() => {
      throw new Error('analysis blew up')
    })

    renderPopup()

    await waitFor(() => expect(screen.getByTestId('save-to-knowledge-analysis-error')).toBeInTheDocument())
    // 关键断言：绝不出现「没有可保存的内容」这一与事实相反的结论。
    expect(screen.queryByText('chat.save.knowledge.empty.no_content')).not.toBeInTheDocument()
    expect(screen.getByText('error.unknown')).toBeInTheDocument()
    expect(screen.getByText('common.retry')).toBeInTheDocument()
    expect(screen.getByTestId('modal-ok')).toBeDisabled()
  })

  it('recovers into the form when the retry succeeds', async () => {
    mocks.analyzeMessageContent.mockImplementationOnce(() => {
      throw new Error('analysis blew up')
    })
    mocks.analyzeMessageContent.mockReturnValueOnce(fullStats())

    renderPopup()

    await waitFor(() => expect(screen.getByTestId('save-to-knowledge-analysis-error')).toBeInTheDocument())

    fireEvent.click(screen.getByText('common.retry'))

    await waitFor(() => expect(screen.queryByTestId('save-to-knowledge-analysis-error')).not.toBeInTheDocument())
    expect(screen.getByTestId('select')).toBeInTheDocument()
    expect(mocks.analyzeMessageContent).toHaveBeenCalledTimes(2)
  })
})

describe('SaveToKnowledgePopup content type rows (c2-24)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { toast: unknown }).toast = { error: mocks.toastError, success: vi.fn() }
    mocks.analyzeMessageContent.mockReturnValue(fullStats({ text: 2, code: 3 }))
  })

  it('exposes each content type as a keyboard-operable checkbox', async () => {
    renderPopup()

    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
    for (const checkbox of checkboxes) {
      expect(checkbox).toHaveAttribute('tabindex', '0')
    }

    const first = checkboxes[0]
    const before = first.getAttribute('aria-checked')
    fireEvent.keyDown(first, { key: 'Enter' })
    await waitFor(() => expect(first.getAttribute('aria-checked')).not.toBe(before))

    fireEvent.keyDown(first, { key: ' ' })
    await waitFor(() => expect(first.getAttribute('aria-checked')).toBe(before))
  })
})
