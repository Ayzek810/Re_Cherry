/**
 * c2-27 行为测试：`MarkdownEditor` 的预览链上有 `rehypeRaw`（原始 HTML 会变成真实节点树），
 * 却没有 sanitize。修复后用仓库既有的 `dompurify` 在交给 ReactMarkdown 之前净化含 HTML 的源码。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import MarkdownEditor from '../index'

describe('MarkdownEditor sanitization (c2-27)', () => {
  it('strips executable markup from the live preview', () => {
    const { container } = render(
      <MarkdownEditor
        value={'<img src="x" onerror="window.__pwned = 1" />\n\n<script>window.__pwned = 2</script>'}
        onChange={vi.fn()}
      />
    )

    const preview = container.querySelector('.markdown') as HTMLElement
    expect(preview.querySelector('script')).toBeNull()
    const img = preview.querySelector('img')
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull()
    }
    expect(preview.innerHTML).not.toContain('__pwned')
  })

  it('renders ordinary markdown untouched', () => {
    const { container } = render(<MarkdownEditor value={'# Title\n\n- a\n- b'} onChange={vi.fn()} />)

    const preview = container.querySelector('.markdown') as HTMLElement
    expect(preview.querySelector('h1')?.textContent).toBe('Title')
    expect(preview.querySelectorAll('li')).toHaveLength(2)
  })

  it('takes its textarea placeholder from i18n', () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // 默认占位符不再硬编码中文：未合并新键时走 defaultValue 兜底。
    expect(textarea.placeholder).not.toBe('请输入Markdown格式文本...')
    expect(textarea.placeholder.length).toBeGreaterThan(0)
  })
})
