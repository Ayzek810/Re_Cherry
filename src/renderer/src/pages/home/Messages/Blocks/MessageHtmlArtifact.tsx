import { useOptionalHtmlArtifactPopupContext } from '@renderer/components/CodeBlockView/HtmlArtifactPopupContext'
import {
  HTML_PREVIEW_RESTRICTED_CSP,
  HTML_PREVIEW_RESTRICTED_SANDBOX,
  HtmlPreviewFrame
} from '@renderer/components/CodeBlockView/HtmlPreviewFrame'
import type { HtmlArtifactKind } from '@renderer/pages/home/Markdown/plugins/remarkHtmlArtifact'
import { extractHtmlTitle } from '@renderer/utils/formats'
import { htmlArtifactRequiresUserConsent } from '@renderer/utils/htmlArtifact'
import { Button } from 'antd'
import { Maximize2 } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface MessageHtmlArtifactProps {
  artifactId: string
  html: string
  onSave?: (html: string) => void
  editable?: boolean
  /** Defaults to the gated `document` path so a missing classification can never open the preview up. */
  kind?: HtmlArtifactKind
  isStreaming?: boolean
}

export const MessageHtmlArtifact = memo(function MessageHtmlArtifact({
  artifactId,
  html,
  onSave,
  editable = false,
  kind = 'document',
  isStreaming = false
}: MessageHtmlArtifactProps) {
  const { t } = useTranslation()
  const popupContext = useOptionalHtmlArtifactPopupContext()
  const title = extractHtmlTitle(html) || t('common.html_preview')
  // Documents with active content stay behind the consent gate; this batch ships no
  // interactive consent UI, so they render a placeholder instead of any preview surface.
  const requiresConsent = kind === 'document' && htmlArtifactRequiresUserConsent(html)

  if (requiresConsent) {
    return (
      <div
        data-html-artifact=""
        data-testid="message-html-artifact"
        className="message-html-artifact special-preview mt-0 mb-2.5 w-full min-w-0 max-w-full">
        <ConsentPlaceholder>{t('html_artifacts.consent_required')}</ConsentPlaceholder>
      </div>
    )
  }

  return (
    <div
      data-html-artifact=""
      data-testid="message-html-artifact"
      className="message-html-artifact special-preview mt-0 mb-2.5 w-full min-w-0 max-w-full">
      <PreviewToolbar>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
        {popupContext ? (
          <Button
            type="text"
            size="small"
            className="nodrag"
            icon={<Maximize2 size={14} />}
            onClick={() => popupContext.openPopup({ artifactId, html, title, onSave, editable, kind, zoom: 100 })}
          />
        ) : null}
      </PreviewToolbar>
      <div className="w-full overflow-hidden" style={{ height: isStreaming ? 350 : 400 }}>
        <HtmlPreviewFrame
          html={html}
          title={title}
          sandbox={HTML_PREVIEW_RESTRICTED_SANDBOX}
          csp={HTML_PREVIEW_RESTRICTED_CSP}
          emptyText={t('html_artifacts.empty_preview', 'No content to preview')}
        />
      </div>
    </div>
  )
})

const PreviewToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  margin-bottom: 4px;
`

const ConsentPlaceholder = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  padding: 0 16px;
  text-align: center;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  color: var(--color-text-secondary);
  font-size: 13px;
`
