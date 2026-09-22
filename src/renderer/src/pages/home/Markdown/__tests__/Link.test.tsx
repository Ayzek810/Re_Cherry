import type { Citation } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CitationRegistryContext } from '../CitationRegistryContext'
import Link from '../Link'

const mocks = vi.hoisted(() => ({
  Hyperlink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <div data-testid="hyperlink" data-href={href}>
      {children}
    </div>
  )
}))

vi.mock('../Hyperlink', () => ({
  default: mocks.Hyperlink
}))

// CitationTooltip 不 mock——真实组件，验证 capsules 行为（antd Tooltip 渲染节流下仅断言不崩溃）
// Markdown 依赖里 antd/styled 已由 vitest 环境（jsdom）可用。

describe('Link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should match snapshot', () => {
    const { container } = render(<Link href="https://example.com">Example</Link>)
    expect(container).toMatchSnapshot()
  })

  it('should render internal anchor as span.link and no <a>', () => {
    const { container } = render(<Link href="#section-1">Go to section</Link>)
    expect(container.querySelector('span.link')).not.toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText('Go to section')).toBeInTheDocument()
  })

  it('should render normal external link inside Hyperlink', () => {
    const onParentClick = vi.fn()
    const { container } = render(
      <div onClick={onParentClick}>
        <Link href="https://domain.com/path">Open</Link>
      </div>
    )

    const wrapper = screen.getByTestId('hyperlink')
    expect(wrapper).toBeInTheDocument()
    expect(wrapper).toHaveAttribute('data-href', 'https://domain.com/path')

    const anchor = container.querySelector('a') as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('https://domain.com/path')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noreferrer')

    fireEvent.click(anchor)
    expect(onParentClick).not.toHaveBeenCalled()
  })
})

describe('Link citation capsules（V2 统一引用机制）', () => {
  const webCitation: Citation = {
    number: 1,
    url: 'https://example.com/page',
    title: 'Example Page',
    content: 'snippet'
  }

  // data-citation 编号经 children 递归查找——只能读元素 props，故直接传普通元素
  // 模拟 react-markdown 传入的 sup 子节点（自定义组件的 props 里没有 data-citation）
  it('renders citation link without crashing when registry has the number and URL matches', () => {
    const registry = new Map<number, Citation>([[1, webCitation]])
    const { container } = render(
      <CitationRegistryContext value={registry}>
        <Link href="https://example.com/page">
          <span>
            <span data-citation="1">1</span>
          </span>
        </Link>
      </CitationRegistryContext>
    )

    // registry 命中 + URL 一致 → 不走 Hyperlink（挂胶囊形态）
    expect(screen.queryByTestId('hyperlink')).toBeNull()
    expect(container.querySelector('a')).not.toBeNull()
  })

  it('falls back to Hyperlink when registry misses the number', () => {
    const registry = new Map<number, Citation>()
    render(
      <CitationRegistryContext value={registry}>
        <Link href="https://example.com/page">
          <span>
            <span data-citation="9">9</span>
          </span>
        </Link>
      </CitationRegistryContext>
    )

    expect(screen.getByTestId('hyperlink')).toBeInTheDocument()
  })

  it('falls back to Hyperlink when href does not match the citation URL (anti-injection, V2)', () => {
    const registry = new Map<number, Citation>([[1, webCitation]])
    render(
      <CitationRegistryContext value={registry}>
        <Link href="https://evil.example.com/hijack">
          <span>
            <span data-citation="1">1</span>
          </span>
        </Link>
      </CitationRegistryContext>
    )

    expect(screen.getByTestId('hyperlink')).toBeInTheDocument()
  })
})
