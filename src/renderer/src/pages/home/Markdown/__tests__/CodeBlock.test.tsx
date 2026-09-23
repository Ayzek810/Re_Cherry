import { MessageBlockStatus } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import CodeBlock from '../CodeBlock'

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  EventEmitter: {
    emit: vi.fn()
  },
  getCodeBlockId: vi.fn(),
  isOpenFenceBlock: vi.fn(),
  selectById: vi.fn(),
  useSettings: vi.fn().mockReturnValue({ codeFancyBlock: true }),
  isWin: false,
  MAX_COLLAPSED_CODE_HEIGHT: 350,
  CodeBlockView: vi.fn(({ onSave, children }) => (
    <div>
      <code>{children}</code>
      <button type="button" onClick={() => onSave('new code content')}>
        Save
      </button>
    </div>
  )),
  HtmlArtifactsCard: vi.fn(({ onSave, html }) => (
    <div>
      <div>{html}</div>
      <button type="button" onClick={() => onSave('new html content')}>
        Save HTML
      </button>
    </div>
  )),
  MessageHtmlArtifact: vi.fn(({ html, onSave, isStreaming, kind, editable, artifactId }) => (
    <div>
      <div>{html}</div>
      <span data-testid="message-html-streaming-state" style={{ display: 'none' }}>
        {String(isStreaming)}
      </span>
      <span data-testid="message-html-kind" style={{ display: 'none' }}>
        {kind}
      </span>
      <span data-testid="message-html-editable" style={{ display: 'none' }}>
        {String(editable)}
      </span>
      <span data-testid="message-html-artifact-id" style={{ display: 'none' }}>
        {artifactId}
      </span>
      <button type="button" onClick={() => onSave('new inline html content')}>
        Save Inline HTML
      </button>
    </div>
  ))
}))

// Mock modules
vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { EDIT_CODE_BLOCK: 'EDIT_CODE_BLOCK' },
  EventEmitter: mocks.EventEmitter
}))

vi.mock('@renderer/utils/markdown', () => ({
  getCodeBlockId: mocks.getCodeBlockId,
  isOpenFenceBlock: mocks.isOpenFenceBlock
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: vi.fn(() => ({})) // Mock store, state doesn't matter here
  }
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: {
    selectById: mocks.selectById
  }
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mocks.useSettings()
}))

vi.mock('@renderer/components/CodeBlockView', () => ({
  CodeBlockView: mocks.CodeBlockView,
  HtmlArtifactsCard: mocks.HtmlArtifactsCard
}))

vi.mock('@renderer/pages/home/Messages/Blocks/MessageHtmlArtifact', () => ({
  MessageHtmlArtifact: mocks.MessageHtmlArtifact
}))

vi.mock('@renderer/config/constant', () => ({
  get isWin() {
    return mocks.isWin
  },
  MAX_COLLAPSED_CODE_HEIGHT: mocks.MAX_COLLAPSED_CODE_HEIGHT
}))

// Mock ClickableFilePath
vi.mock('@renderer/pages/home/Messages/Tools/MessageAgentTools/ClickableFilePath', () => ({
  ClickableFilePath: ({ path }: { path: string }) => <span data-testid="clickable-file-path">{path}</span>
}))

describe('CodeBlock', () => {
  const defaultProps = {
    blockId: 'test-msg-block-id',
    node: {
      position: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 2, column: 1, offset: 2 },
        value: 'console.log("hello world")'
      }
    },
    children: 'console.log("hello world")',
    className: 'language-javascript'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWin = false
    // Default mock return values
    mocks.getCodeBlockId.mockReturnValue('test-code-block-id')
    mocks.isOpenFenceBlock.mockReturnValue(false)
    mocks.selectById.mockReturnValue({
      id: 'test-msg-block-id',
      status: MessageBlockStatus.SUCCESS
    })
  })

  describe('rendering', () => {
    it('should render a snapshot', () => {
      const { container } = render(<CodeBlock {...defaultProps} />)
      expect(container).toMatchSnapshot()
    })

    it('should render inline code when no language match is found', () => {
      const inlineProps = {
        ...defaultProps,
        className: undefined,
        children: 'inline code'
      }
      render(<CodeBlock {...inlineProps} />)

      const codeElement = screen.getByText('inline code')
      expect(codeElement.tagName).toBe('CODE')
      expect(mocks.CodeBlockView).not.toHaveBeenCalled()
    })

    it('should render ClickableFilePath for absolute file paths', () => {
      const pathProps = {
        ...defaultProps,
        className: undefined,
        children: '/Users/foo/bar.tsx'
      }
      render(<CodeBlock {...pathProps} />)

      expect(screen.getByTestId('clickable-file-path')).toBeInTheDocument()
      expect(screen.getByText('/Users/foo/bar.tsx')).toBeInTheDocument()
    })

    it.each(['/home/user/project/src/index.ts', '/tmp/test.log', '/var/log/app.log', '/etc/nginx/nginx.conf'])(
      'should detect %s as a file path',
      (path) => {
        render(<CodeBlock {...defaultProps} className={undefined} children={path} />)
        expect(screen.getByTestId('clickable-file-path')).toBeInTheDocument()
      }
    )

    it.each(['inline code', '/single-segment', '//comment style', 'not/absolute/path', '/path with spaces/file.ts'])(
      'should NOT detect %s as a file path',
      (text) => {
        render(<CodeBlock {...defaultProps} className={undefined} children={text} />)
        expect(screen.queryByTestId('clickable-file-path')).not.toBeInTheDocument()
      }
    )

    it.each(['/home/user/project/src/index.ts', '/tmp/test.log', '/var/log/app.log', '/etc/nginx/nginx.conf'])(
      'should NOT detect %s as a file path on Windows',
      (path) => {
        mocks.isWin = true
        render(<CodeBlock {...defaultProps} className={undefined} children={path} />)
        expect(screen.queryByTestId('clickable-file-path')).not.toBeInTheDocument()
      }
    )
  })

  describe('save', () => {
    it('should call EventEmitter with correct payload when saving a standard code block', () => {
      render(<CodeBlock {...defaultProps} />)

      // Simulate clicking the save button inside the mocked CodeBlockView
      const saveButton = screen.getByText('Save')
      fireEvent.click(saveButton)

      // Verify getCodeBlockId was called
      expect(mocks.getCodeBlockId).toHaveBeenCalledWith(defaultProps.node.position.start)

      // Verify EventEmitter.emit was called
      expect(mocks.EventEmitter.emit).toHaveBeenCalledOnce()
      expect(mocks.EventEmitter.emit).toHaveBeenCalledWith('EDIT_CODE_BLOCK', {
        msgBlockId: 'test-msg-block-id',
        codeBlockId: 'test-code-block-id',
        newContent: 'new code content'
      })
    })

    it('should call EventEmitter with correct payload when saving an HTML block', () => {
      const htmlProps = {
        ...defaultProps,
        className: 'language-html',
        children: '<h1>Hello</h1>'
      }
      render(<CodeBlock {...htmlProps} />)

      // Simulate clicking the save button inside the mocked HtmlArtifactsCard
      const saveButton = screen.getByText('Save HTML')
      fireEvent.click(saveButton)

      // Verify getCodeBlockId was called
      expect(mocks.getCodeBlockId).toHaveBeenCalledWith(htmlProps.node.position.start)

      // Verify EventEmitter.emit was called
      expect(mocks.EventEmitter.emit).toHaveBeenCalledOnce()
      expect(mocks.EventEmitter.emit).toHaveBeenCalledWith('EDIT_CODE_BLOCK', {
        msgBlockId: 'test-msg-block-id',
        codeBlockId: 'test-code-block-id',
        newContent: 'new html content'
      })
    })

    it('should call EventEmitter when saving an inline HTML artifact', () => {
      render(
        <CodeBlock
          {...defaultProps}
          className="language-html"
          inlineHtmlPreviewMode="ready">
          {'<h1>Hello</h1>'}
        </CodeBlock>
      )

      fireEvent.click(screen.getByRole('button', { name: 'Save Inline HTML' }))

      expect(mocks.EventEmitter.emit).toHaveBeenCalledWith('EDIT_CODE_BLOCK', {
        msgBlockId: 'test-msg-block-id',
        codeBlockId: 'test-code-block-id',
        newContent: 'new inline html content'
      })
    })
  })

  describe('inline html preview (V2 port)', () => {
    it('renders completed HTML directly in its original Markdown position', () => {
      render(
        <CodeBlock
          {...defaultProps}
          className="language-html"
          inlineHtmlPreviewMode="ready">
          {'<h1>Hello</h1>'}
        </CodeBlock>
      )

      expect(mocks.HtmlArtifactsCard).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: 'test-msg-block-id:test-code-block-id',
          editable: true,
          html: '<h1>Hello</h1>',
          kind: 'fragment',
          isStreaming: false,
          onSave: expect.any(Function)
        }),
        undefined
      )
    })

    it('classifies a completed HTML document so the view can gate it', () => {
      const html =
        '<!doctype html><html><head><link rel="stylesheet" href="https://example.com/style.css"></head></html>'
      render(
        <CodeBlock {...defaultProps} className="language-html" inlineHtmlPreviewMode="ready">
          {html}
        </CodeBlock>
      )

      expect(mocks.HtmlArtifactsCard).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ html, kind: 'document', isStreaming: false }),
        undefined
      )
    })

    it('classifies active markup embedded in prose as a fragment, never gated', () => {
      const html = '<script>document.body.textContent = "interactive"</script>'
      render(
        <CodeBlock {...defaultProps} className="language-html" inlineHtmlPreviewMode="ready">
          {html}
        </CodeBlock>
      )

      expect(mocks.HtmlArtifactsCard).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ html, kind: 'fragment', isStreaming: false }),
        undefined
      )
    })

    it('renders a streaming fenced HTML fragment in the existing message artifact view', () => {
      render(
        <CodeBlock {...defaultProps} className="language-html" inlineHtmlPreviewMode="generating">
          {'<div><h1>Hello</h1></div>'}
        </CodeBlock>
      )

      expect(mocks.HtmlArtifactsCard).not.toHaveBeenCalled()
      expect(mocks.CodeBlockView).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<div><h1>Hello</h1></div>', kind: 'fragment', isStreaming: true }),
        undefined
      )
      expect(screen.getByTestId('message-html-streaming-state')).toHaveTextContent('true')
    })

    it('keeps a streaming HTML document in the display-only source view', () => {
      const html = '<!doctype html><html><body><h1>Hello</h1></body></html>'
      render(
        <CodeBlock {...defaultProps} className="language-html" inlineHtmlPreviewMode="generating">
          {html}
        </CodeBlock>
      )

      expect(mocks.HtmlArtifactsCard).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).not.toHaveBeenCalled()
      expect(mocks.CodeBlockView).toHaveBeenCalledWith(
        expect.objectContaining({
          children: html,
          editable: false,
          language: 'html',
          isStreaming: true,
          maxHeight: 350,
          showToolbar: false
        }),
        undefined
      )
    })

    it('renders an empty streaming fence without crashing', () => {
      expect(() =>
        render(
          <CodeBlock
            blockId={defaultProps.blockId}
            node={defaultProps.node}
            className="language-html"
            inlineHtmlPreviewMode="generating">
            {''}
          </CodeBlock>
        )
      ).not.toThrow()

      expect(mocks.CodeBlockView).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).not.toHaveBeenCalled()
    })

    it('holds the surface until a streamed prefix can be classified', () => {
      const partial = '<!doc'
      render(
        <CodeBlock {...defaultProps} className="language-html" inlineHtmlPreviewMode="generating">
          {partial}
        </CodeBlock>
      )

      expect(mocks.CodeBlockView).not.toHaveBeenCalled()
      expect(mocks.MessageHtmlArtifact).not.toHaveBeenCalled()
    })

    it('falls back to the fragment surface for unclassifiable but completed HTML', () => {
      render(
        <CodeBlock {...defaultProps} className="language-html" inlineHtmlPreviewMode="ready">
          {'plain text in an html fence'}
        </CodeBlock>
      )

      expect(mocks.MessageHtmlArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'fragment', isStreaming: false }),
        undefined
      )
    })

    it('keeps the legacy HtmlArtifactsCard surface when no preview mode is set', () => {
      const htmlProps = {
        ...defaultProps,
        className: 'language-html',
        children: '<h1>Hello</h1>'
      }
      render(<CodeBlock {...htmlProps} />)

      expect(mocks.MessageHtmlArtifact).not.toHaveBeenCalled()
      expect(mocks.HtmlArtifactsCard).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<h1>Hello</h1>', onSave: expect.any(Function) }),
        undefined
      )
    })
  })
})
