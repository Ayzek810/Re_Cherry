import { configureStore } from '@reduxjs/toolkit'
import { selectFormattedCitationsByBlockId } from '@renderer/store/messageBlock'
import type { Model } from '@renderer/types'
import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MainTextBlock from '../MainTextBlock'

// Mock dependencies
const mockUseSettings = vi.fn()
const mockUseSelector = vi.fn()

// Mock hooks
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mockUseSettings()
}))

vi.mock('react-redux', async () => {
  const actual = await import('react-redux')
  return {
    ...actual,
    useSelector: () => mockUseSelector(),
    useDispatch: () => vi.fn()
  }
})

// Mock store to avoid withTypes issues
vi.mock('@renderer/store', () => ({
  useAppSelector: vi.fn(),
  useAppDispatch: vi.fn(() => vi.fn())
}))

// Mock store selectors
vi.mock('@renderer/store/messageBlock', async () => {
  const actual = await import('@renderer/store/messageBlock')
  return {
    ...actual,
    selectFormattedCitationsByBlockId: vi.fn(() => [])
  }
})

// Mock citation utilities（真实管线，隔离 markdown 清洗依赖）
vi.mock('@renderer/utils/citation', async () => {
  const actual = await import('@renderer/utils/citation')
  return {
    ...actual,
    toTooltipCitation: (c: any) => c
  }
})

// Mock utilities
vi.mock('@renderer/utils/formats', () => ({
  cleanMarkdownContent: vi.fn((content: string) => content),
  encodeHTML: vi.fn((content: string) => content.replace(/"/g, '&quot;'))
}))

// Mock services
vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: vi.fn()
}))

// Mock Markdown component
vi.mock('@renderer/pages/home/Markdown/Markdown', () => ({
  __esModule: true,
  default: ({ block, postProcess, citationRegistry }: any) => {
    const content = postProcess ? postProcess(block.content) : block.content
    return (
      <div
        data-testid="mock-markdown"
        data-content={content}
        data-registry-size={citationRegistry ? String(citationRegistry.size) : undefined}>
        Markdown: {content}
      </div>
    )
  }
}))

describe('MainTextBlock', () => {
  // Get references to mocked modules
  let mockGetModelUniqId: any

  // Create a mock store for Provider
  const mockStore = configureStore({
    reducer: {
      messageBlocks: (state = {}) => state
    }
  })

  beforeEach(async () => {
    vi.clearAllMocks()

    // Get the mocked functions
    const { getModelUniqId } = await import('@renderer/services/ModelService')
    mockGetModelUniqId = getModelUniqId as any

    // Default mock implementations
    mockUseSettings.mockReturnValue({ renderInputMessageAsMarkdown: false })
    // useSelector 默认返回空引用清单（生产 selector 恒返回数组；citation 用例各自覆写）
    mockUseSelector.mockReturnValue([])
    mockGetModelUniqId.mockImplementation((model: Model) => `${model.id}-${model.name}`)
  })

  // Test data factory functions
  const createMainTextBlock = (overrides: Partial<MainTextMessageBlock> = {}): MainTextMessageBlock => ({
    id: 'test-block-1',
    messageId: 'test-message-1',
    type: MessageBlockType.MAIN_TEXT,
    status: MessageBlockStatus.SUCCESS,
    createdAt: new Date().toISOString(),
    content: 'Test content',
    ...overrides
  })

  const createModel = (overrides: Partial<Model> = {}): Model =>
    ({
      id: 'test-model-1',
      name: 'Test Model',
      provider: 'test-provider',
      ...overrides
    }) as Model

  // Helper functions
  const renderMainTextBlock = (props: {
    block: MainTextMessageBlock
    role: 'user' | 'assistant'
    mentions?: Model[]
  }) => {
    return render(
      <Provider store={mockStore}>
        <MainTextBlock {...props} />
      </Provider>
    )
  }

  // User-focused query helpers
  const getRenderedMarkdown = () => screen.queryByTestId('mock-markdown')
  const getRenderedPlainText = () => screen.queryByRole('paragraph')
  const getMentionElements = () => screen.queryAllByText(/@/)

  describe('basic rendering', () => {
    it('should render in markdown mode for assistant messages', () => {
      const block = createMainTextBlock({ content: 'Assistant response' })
      renderMainTextBlock({ block, role: 'assistant' })

      // User should see markdown-rendered content
      expect(getRenderedMarkdown()).toBeInTheDocument()
      expect(screen.getByText('Markdown: Assistant response')).toBeInTheDocument()
      expect(getRenderedPlainText()).not.toBeInTheDocument()
    })

    it('should render in plain text mode for user messages when setting disabled', () => {
      mockUseSettings.mockReturnValue({ renderInputMessageAsMarkdown: false })
      const block = createMainTextBlock({ content: 'User message\nWith line breaks' })
      renderMainTextBlock({ block, role: 'user' })

      // User should see plain text with preserved formatting
      expect(getRenderedPlainText()).toBeInTheDocument()
      expect(getRenderedPlainText()!.textContent).toBe('User message\nWith line breaks')
      expect(getRenderedMarkdown()).not.toBeInTheDocument()

      // Check preserved whitespace
      const textElement = getRenderedPlainText()!
      expect(textElement).toHaveStyle({ whiteSpace: 'pre-wrap' })
    })

    it('should render user messages as markdown when setting enabled', () => {
      mockUseSettings.mockReturnValue({ renderInputMessageAsMarkdown: true })
      const block = createMainTextBlock({ content: 'User **bold** content' })
      renderMainTextBlock({ block, role: 'user' })

      expect(getRenderedMarkdown()).toBeInTheDocument()
      expect(screen.getByText('Markdown: User **bold** content')).toBeInTheDocument()
    })

    it('should preserve complex formatting in plain text mode', () => {
      mockUseSettings.mockReturnValue({ renderInputMessageAsMarkdown: false })
      const complexContent = `Line 1
  Indented line
**Bold not parsed**
- List not parsed`

      const block = createMainTextBlock({ content: complexContent })
      renderMainTextBlock({ block, role: 'user' })

      const textElement = getRenderedPlainText()!
      expect(textElement.textContent).toBe(complexContent)
      expect(textElement).toHaveClass('markdown')
    })

    it('should handle empty content gracefully', () => {
      const block = createMainTextBlock({ content: '' })
      expect(() => {
        renderMainTextBlock({ block, role: 'assistant' })
      }).not.toThrow()

      expect(getRenderedMarkdown()).toBeInTheDocument()
    })
  })

  describe('mentions functionality', () => {
    it('should display model mentions when provided', () => {
      const block = createMainTextBlock({ content: 'Content with mentions' })
      const mentions = [
        createModel({ id: 'model-1', name: 'deepseek-r1' }),
        createModel({ id: 'model-2', name: 'claude-sonnet-4' })
      ]

      renderMainTextBlock({ block, role: 'assistant', mentions })

      // User should see mention tags
      expect(screen.getByText('@deepseek-r1')).toBeInTheDocument()
      expect(screen.getByText('@claude-sonnet-4')).toBeInTheDocument()

      // Service should be called for model processing
      expect(mockGetModelUniqId).toHaveBeenCalledTimes(2)
      expect(mockGetModelUniqId).toHaveBeenCalledWith(mentions[0])
      expect(mockGetModelUniqId).toHaveBeenCalledWith(mentions[1])
    })

    it('should not display mentions when none provided', () => {
      const block = createMainTextBlock({ content: 'No mentions content' })

      renderMainTextBlock({ block, role: 'assistant', mentions: [] })
      expect(getMentionElements()).toHaveLength(0)

      renderMainTextBlock({ block, role: 'assistant', mentions: undefined })
      expect(getMentionElements()).toHaveLength(0)
    })

    it('should style mentions correctly for user visibility', () => {
      const block = createMainTextBlock({ content: 'Styled mentions test' })
      const mentions = [createModel({ id: 'model-1', name: 'Test Model' })]

      renderMainTextBlock({ block, role: 'assistant', mentions })

      const mentionElement = screen.getByText('@Test Model')
      expect(mentionElement).toHaveStyle({ color: 'var(--color-link)' })

      // Check container layout
      const container = mentionElement.closest('[style*="gap"]')
      expect(container).toHaveStyle({
        gap: '8px',
        marginBottom: '10px'
      })
    })
  })

  describe('settings integration', () => {
    it('should respond to markdown rendering setting changes', () => {
      const block = createMainTextBlock({ content: 'Settings test content' })

      // Test with markdown enabled
      mockUseSettings.mockReturnValue({ renderInputMessageAsMarkdown: true })
      const { unmount } = renderMainTextBlock({ block, role: 'user' })
      expect(getRenderedMarkdown()).toBeInTheDocument()
      unmount()

      // Test with markdown disabled
      mockUseSettings.mockReturnValue({ renderInputMessageAsMarkdown: false })
      renderMainTextBlock({ block, role: 'user' })
      expect(getRenderedPlainText()).toBeInTheDocument()
      expect(getRenderedMarkdown()).not.toBeInTheDocument()
    })
  })

  describe('integration and robustness', () => {
    it('should handle null and undefined values gracefully', () => {
      const block = createMainTextBlock({ content: 'Null safety test' })

      expect(() => {
        renderMainTextBlock({
          block,
          role: 'assistant',
          mentions: undefined
        })
      }).not.toThrow()

      expect(getRenderedMarkdown()).toBeInTheDocument()
    })
  })

  describe('citation pipeline（统一引用机制）', () => {
    // Helper: 带 store 注入的渲染（citationBlockId + redux selector mock）
    const renderWithCitations = (
      block: MainTextMessageBlock,
      citationBlockId: string | undefined,
      citations: any[]
    ) => {
      vi.mocked(selectFormattedCitationsByBlockId).mockImplementation(() => citations)
      mockUseSelector.mockImplementation(() => citations)
      return render(
        <Provider store={mockStore}>
          <MainTextBlock block={block} citationBlockId={citationBlockId} role="assistant" />
        </Provider>
      )
    }

    it('turns [n] into sup tags when citationReferences + citations exist', () => {
      const block = createMainTextBlock({
        content: 'Answer with source [1].',
        citationReferences: [{ citationBlockId: 'cite-1' }]
      })
      vi.mocked(selectFormattedCitationsByBlockId).mockImplementation(() => [
        { number: 1, url: 'https://example.com/a', title: 'A', content: 'snippet A' }
      ])
      mockUseSelector.mockImplementation(() => [
        { number: 1, url: 'https://example.com/a', title: 'A', content: 'snippet A' }
      ])

      render(
        <Provider store={mockStore}>
          <MainTextBlock block={block} citationBlockId="cite-1" role="assistant" />
        </Provider>
      )

      const md = getRenderedMarkdown()!
      expect(md).toHaveAttribute(
        'data-content',
        "Answer with source [<sup data-citation='1'>1</sup>](https://example.com/a)."
      )
      // V2 安全加固：registry out-of-band 传递，且只含安全形态
      expect(md).toHaveAttribute('data-registry-size', '1')
    })

    it('emits bare sup (no link) for knowledge citations without URL', () => {
      const block = createMainTextBlock({
        content: 'From docs [1].',
        citationReferences: [{ citationBlockId: 'cite-1' }]
      })
      const knowledge = [{ number: 1, url: '', title: 'doc.md', content: 'kb snippet' }]
      vi.mocked(selectFormattedCitationsByBlockId).mockImplementation(() => knowledge)
      mockUseSelector.mockImplementation(() => knowledge)

      render(
        <Provider store={mockStore}>
          <MainTextBlock block={block} citationBlockId="cite-1" role="assistant" />
        </Provider>
      )

      const md = getRenderedMarkdown()!
      expect(md).toHaveAttribute('data-content', "From docs <sup data-citation='1'>1</sup>.")
    })

    it('leaves text untouched when no citationReferences', () => {
      const block = createMainTextBlock({ content: 'No refs [1] here.' })
      renderWithCitations(block, undefined, [{ number: 1, url: 'https://example.com', title: 'x' }])

      const md = getRenderedMarkdown()!
      expect(md).toHaveAttribute('data-content', 'No refs [1] here.')
      expect(md).toHaveAttribute('data-registry-size', undefined as any)
    })
  })
})
