import { useOptionalHtmlArtifactPopupContext } from '@renderer/components/CodeBlockView/HtmlArtifactPopupContext'
import {
  HTML_PREVIEW_RESTRICTED_CSP,
  HTML_PREVIEW_RESTRICTED_SANDBOX,
  HtmlPreviewFrame
} from '@renderer/components/CodeBlockView/HtmlPreviewFrame'
import { InteractiveHtmlPreview } from '@renderer/components/CodeBlockView/InteractiveHtmlPreview'
import type { HtmlArtifactKind } from '@renderer/pages/home/Markdown/plugins/remarkHtmlArtifact'
import { extractHtmlTitle } from '@renderer/utils/formats'
import { htmlArtifactRequiresUserConsent } from '@renderer/utils/htmlArtifact'
import { Button } from 'antd'
import { Maximize2, ShieldAlert } from 'lucide-react'
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
  // Documents with active content stay behind the consent gate until the user approves this
  // exact html string: approval is keyed by artifactId → html, so any content change re-gates.
  const requiresConsent = kind === 'document' && htmlArtifactRequiresUserConsent(html)
  const isInteractiveApproved =
    requiresConsent && popupContext?.approvedInteractiveHtmlById[artifactId] === html
  const isPreviewBlocked = requiresConsent && !isInteractiveApproved

  if (isPreviewBlocked) {
    return (
      <div
        data-html-artifact=""
        data-testid="message-html-artifact"
        className="message-html-artifact special-preview mt-0 mb-2.5 w-full min-w-0 max-w-full">
        <ConsentCard
          type="button"
          data-testid="html-artifact-consent-card"
          aria-label={t('html_artifacts.interactive_preview.action')}
          onClick={() => popupContext?.approveInteractiveHtml(artifactId, html)}>
          <ConsentHeader>
            <ShieldAlert size={14} className="mt-0.5 shrink-0" color="var(--color-status-warning)" />
            <ConsentTitle>{title}</ConsentTitle>
            <ConsentAction>{t('html_artifacts.interactive_preview.action')}</ConsentAction>
          </ConsentHeader>
          <ConsentDescription>{t('html_artifacts.interactive_preview.description')}</ConsentDescription>
        </ConsentCard>
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
        {isInteractiveApproved ? (
          // Consent was given for exactly this html string, so the sandboxed guest may run it.
          <InteractiveHtmlPreview html={html} title={title} />
        ) : (
          <HtmlPreviewFrame
            html={html}
            title={title}
            sandbox={HTML_PREVIEW_RESTRICTED_SANDBOX}
            csp={HTML_PREVIEW_RESTRICTED_CSP}
            emptyText={t('html_artifacts.empty_preview', 'No content to preview')}
          />
        )}
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

const ConsentCard = styled.button`
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  cursor: pointer;
  transition: border-color 0.2s;

  &:hover {
    border-color: var(--color-primary);
  }
`

const ConsentHeader = styled.span`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const ConsentTitle = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 500;
`

const ConsentAction = styled.span`
  flex-shrink: 0;
  color: var(--color-primary);
  font-size: 12px;
`

const ConsentDescription = styled.span`
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
`
