/**
 * 交互式 HTML 预览载体（V2 `HtmlArtifactView` 内 `InteractiveHtmlPreview` 的 fork 形态）：
 * 用户同意后把文档放进专用 partition 的 `<webview>`；该 partition 的权限/请求/导航加固在
 * 主进程（`src/main/utils/htmlArtifactSecurity.ts`）。fork 精简版不含 V2 的
 * console-message 高度/滚轮桥与缩放层——固定高度交给外层容器，与静态预览面一致。
 */
import { HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX, HTML_ARTIFACT_PREVIEW_PARTITION } from '@shared/utils/htmlArtifact'
import { memo, useMemo } from 'react'

interface InteractiveHtmlPreviewProps {
  html: string
  title: string
}

export const InteractiveHtmlPreview = memo<InteractiveHtmlPreviewProps>(({ html, title }) => {
  const src = useMemo(() => `${HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX}${encodeURIComponent(html)}`, [html])

  return (
    <webview
      data-testid="interactive-html-webview"
      src={src}
      partition={HTML_ARTIFACT_PREVIEW_PARTITION}
      aria-label={title}
      style={{ display: 'inline-flex', width: '100%', height: '100%', backgroundColor: '#fff' }}
    />
  )
})

export default InteractiveHtmlPreview
