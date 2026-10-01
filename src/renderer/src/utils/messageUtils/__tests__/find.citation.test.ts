import { beforeEach, describe, expect, it, vi } from 'vitest'

// find.ts 的块表查询走 store selector；这里直接返回构造好的块。
let mockBlocks: Record<string, any> = {}

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({})
  }
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: {
    selectById: (_state: unknown, id: string) => mockBlocks[id]
  },
  formatCitationsFromBlock: vi.fn()
}))

import { formatCitationsFromBlock } from '@renderer/store/messageBlock'

import { getCitationContent } from '../find'

const createMessage = (blockIds: string[]) => ({ id: 'msg-1', blocks: blockIds }) as any

describe('messageUtils/find – getCitationContent（audit2 r2-78）', () => {
  beforeEach(() => {
    mockBlocks = {}
    vi.clearAllMocks()
  })

  const setCitations = (citations: Array<{ number: number; url?: string; title?: string }>) => {
    mockBlocks = {
      'citation-block-1': { id: 'citation-block-1', type: 'citation', messageId: 'msg-1' }
    }
    vi.mocked(formatCitationsFromBlock).mockReturnValue(citations as any)
  }

  it('does not throw when url AND title are both empty (knowledge-base citation)', () => {
    setCitations([{ number: 3, url: '', title: '' }])

    // 原先 citation.url.slice(...) 直接抛 TypeError，整段导出失败。
    expect(() => getCitationContent(createMessage(['citation-block-1']))).not.toThrow()
    const result = getCitationContent(createMessage(['citation-block-1']))
    // 无 url → 非链接形态；无 title → 中性占位（不崩溃、不留空）。
    expect(result).toBe('[3] Untitled')
    expect(result).not.toContain('](')
  })

  it('renders a non-link form when url is empty but a title exists', () => {
    setCitations([{ number: 1, url: '', title: '知识库文档.md' }])

    const result = getCitationContent(createMessage(['citation-block-1']))

    expect(result).toBe('[1] 知识库文档.md')
    expect(result).not.toContain('](')
  })

  it('renders a non-link form for a non-http url (same rule as the citation UI)', () => {
    setCitations([{ number: 2, url: 'invalid-url', title: 'Test Title' }])

    expect(getCitationContent(createMessage(['citation-block-1']))).toBe('[2] Test Title')
  })

  it('keeps the markdown link form for a normal url', () => {
    setCitations([{ number: 1, url: 'https://example.com', title: 'Example' }])

    expect(getCitationContent(createMessage(['citation-block-1']))).toBe('[1] [Example](https://example.com)')
  })

  it('falls back to the url as link text when the title is missing', () => {
    setCitations([{ number: 1, url: 'https://example.com', title: undefined }])

    expect(getCitationContent(createMessage(['citation-block-1']))).toBe(
      '[1] [https://example.com](https://example.com)'
    )
  })

  it('truncates a very long url instead of failing', () => {
    const longUrl = `https://example.com/${'a'.repeat(3000)}`
    setCitations([{ number: 1, url: longUrl, title: 'Long' }])

    const result = getCitationContent(createMessage(['citation-block-1']))
    const linkTarget = result.slice(result.indexOf('](') + 2, -1)

    expect(linkTarget).toHaveLength(1999)
  })

  it('joins multiple citations with a blank line', () => {
    setCitations([
      { number: 1, url: 'https://example.com', title: 'A' },
      { number: 2, url: '', title: '' }
    ])

    expect(getCitationContent(createMessage(['citation-block-1']))).toBe('[1] [A](https://example.com)\n\n[2] Untitled')
  })

  it('returns an empty string for a message without citation blocks', () => {
    vi.mocked(formatCitationsFromBlock).mockReturnValue([])
    expect(getCitationContent(createMessage([]))).toBe('')
  })
})
