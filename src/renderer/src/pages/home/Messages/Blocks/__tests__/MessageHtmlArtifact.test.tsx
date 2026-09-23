import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MessageHtmlArtifact } from '../MessageHtmlArtifact'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('MessageHtmlArtifact', () => {
  it('gates a document with active content behind the consent placeholder', () => {
    render(<MessageHtmlArtifact artifactId="artifact" html="<script>alert(1)</script>" kind="document" />)

    expect(screen.getByTestId('message-html-artifact')).toHaveTextContent('html_artifacts.consent_required')
    expect(screen.queryByTitle('common.html_preview')).not.toBeInTheDocument()
  })

  it('defaults the kind to the gated document classification', () => {
    render(<MessageHtmlArtifact artifactId="artifact" html="<script>alert(1)</script>" />)

    expect(screen.getByTestId('message-html-artifact')).toHaveTextContent('html_artifacts.consent_required')
    expect(screen.queryByTitle('common.html_preview')).not.toBeInTheDocument()
  })

  it('renders a static document in the restricted script-less preview surface', () => {
    render(<MessageHtmlArtifact artifactId="artifact" html="<title>Demo</title><h1>Hello</h1>" kind="document" />)

    expect(screen.getByTestId('message-html-artifact')).toHaveAttribute('data-html-artifact')
    const iframe = screen.getByTitle('Demo')
    expect(iframe).toHaveAttribute('sandbox', '')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'")
    // No popup host mounted → no popup entry point.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('never gates a fragment, even one with active markup', () => {
    render(<MessageHtmlArtifact artifactId="artifact" html="<script>alert(1)</script>" kind="fragment" />)

    expect(screen.queryByText('html_artifacts.consent_required')).not.toBeInTheDocument()
    const iframe = screen.getByTitle('common.html_preview')
    expect(iframe).toHaveAttribute('sandbox', '')
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'")
  })
})
