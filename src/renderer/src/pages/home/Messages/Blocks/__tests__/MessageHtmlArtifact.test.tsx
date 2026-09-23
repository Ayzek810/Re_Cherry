/**
 * 交互式 HTML 预览的同意门行为测试：静态文档与片段走无脚本受限帧；含活动内容的文档
 * 必须先经同意卡，批准只对「这一个 html 串」有效（内容一变即重新要求同意），
 * 批准后挂载专用 partition 的沙箱 webview。
 * 另钉住卡片工具栏的两枚按钮：复制源代码、预览/代码切换。
 */
import { HtmlArtifactPopupHost } from '@renderer/components/CodeBlockView/HtmlArtifactPopupContext'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageHtmlArtifact } from '../MessageHtmlArtifact'

// 保留模块其余导出（i18n/index.ts 依赖 initReactI18next，整体替换会让测试文件加载失败）。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

// CodeViewer 需要 CodeStyleProvider 上下文与虚拟滚动测量，这里只钉"切到代码 = 渲染源码"这条契约。
vi.mock('@renderer/components/CodeViewer', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="artifact-code-view">{value}</pre>
}))

const renderArtifact = (props: ComponentProps<typeof MessageHtmlArtifact>) =>
  render(
    <HtmlArtifactPopupHost>
      <MessageHtmlArtifact {...props} />
    </HtmlArtifactPopupHost>
  )

describe('MessageHtmlArtifact', () => {
  beforeEach(() => {
    window.toast = { success: vi.fn(), error: vi.fn() } as any
  })

  it('gates a document with active content behind the consent card', () => {
    renderArtifact({ artifactId: 'artifact', html: '<script>alert(1)</script>', kind: 'document' })

    const consentCard = screen.getByTestId('html-artifact-consent-card')
    expect(consentCard).toHaveTextContent('html_artifacts.interactive_preview.action')
    expect(consentCard).toHaveTextContent('html_artifacts.interactive_preview.description')
    expect(screen.queryByTestId('interactive-html-webview')).not.toBeInTheDocument()
    expect(screen.queryByTitle('common.html_preview')).not.toBeInTheDocument()
    // 未同意时不存在任何预览帧（同意卡是唯一出口）。
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('defaults the kind to the gated document classification', () => {
    renderArtifact({ artifactId: 'artifact', html: '<script>alert(1)</script>' })

    expect(screen.getByTestId('html-artifact-consent-card')).toBeInTheDocument()
  })

  it('mounts the sandboxed interactive preview once the user consents', () => {
    renderArtifact({ artifactId: 'artifact', html: '<script>alert(1)</script>', kind: 'document' })

    fireEvent.click(screen.getByTestId('html-artifact-consent-card'))

    const webview = screen.getByTestId('interactive-html-webview')
    expect(webview).toHaveAttribute('partition', 'html-artifact-preview')
    expect(webview.getAttribute('src')).toContain('data:text/html;charset=utf-8,')
    expect(webview.getAttribute('src')).toContain(encodeURIComponent('<script>alert(1)</script>'))
    expect(screen.queryByTestId('html-artifact-consent-card')).not.toBeInTheDocument()
  })

  it('requires new consent when the interactive html content changes', () => {
    const { rerender } = render(
      <HtmlArtifactPopupHost>
        <MessageHtmlArtifact artifactId="artifact" html="<script>one()</script>" kind="document" />
      </HtmlArtifactPopupHost>
    )

    fireEvent.click(screen.getByTestId('html-artifact-consent-card'))
    expect(screen.getByTestId('interactive-html-webview')).toBeInTheDocument()

    rerender(
      <HtmlArtifactPopupHost>
        <MessageHtmlArtifact artifactId="artifact" html="<script>two()</script>" kind="document" />
      </HtmlArtifactPopupHost>
    )

    expect(screen.getByTestId('html-artifact-consent-card')).toBeInTheDocument()
    expect(screen.queryByTestId('interactive-html-webview')).not.toBeInTheDocument()
  })

  it('renders a static document in the restricted script-less preview surface', () => {
    renderArtifact({ artifactId: 'artifact', html: '<title>Demo</title><h1>Hello</h1>', kind: 'document' })

    expect(screen.getByTestId('message-html-artifact')).toHaveAttribute('data-html-artifact')
    expect(screen.queryByTestId('html-artifact-consent-card')).not.toBeInTheDocument()
    const iframe = screen.getByTitle('Demo')
    expect(iframe).toHaveAttribute('sandbox', '')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'")
  })

  it('never gates a fragment, even one with active markup', () => {
    renderArtifact({ artifactId: 'artifact', html: '<script>alert(1)</script>', kind: 'fragment' })

    expect(screen.queryByTestId('html-artifact-consent-card')).not.toBeInTheDocument()
    const iframe = screen.getByTitle('common.html_preview')
    expect(iframe).toHaveAttribute('sandbox', '')
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'")
  })

  it('copies the html source with the toolbar copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderArtifact({ artifactId: 'artifact', html: '<h1>Hello</h1>\n', kind: 'document' })

    fireEvent.click(screen.getByLabelText('code_block.copy.source'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('<h1>Hello</h1>'))
    expect(window.toast.success).toHaveBeenCalledWith('code_block.copy.success')
  })

  it('switches between the preview and the html source view', () => {
    renderArtifact({ artifactId: 'artifact', html: '<h1>Hello</h1>', kind: 'document' })

    // 预览面与源码面互斥，且预览**不卸载**（重建 iframe 要重解析整份文档）。
    const iframe = screen.getByTitle('common.html_preview')
    expect(iframe).toBeVisible()

    fireEvent.click(screen.getByLabelText('html_artifacts.code'))

    expect(screen.getByLabelText('html_artifacts.preview')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('artifact-code-view')).toHaveTextContent('<h1>Hello</h1>')
    expect(iframe).not.toBeVisible()
    expect(screen.getByTitle('common.html_preview')).toBe(iframe)

    fireEvent.click(screen.getByLabelText('html_artifacts.preview'))

    expect(screen.getByLabelText('html_artifacts.code')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('artifact-code-view')).not.toBeInTheDocument()
    expect(iframe).toBeVisible()
  })
})
