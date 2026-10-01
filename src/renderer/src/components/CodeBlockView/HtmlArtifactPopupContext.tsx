import type { HtmlArtifactKind } from '@renderer/pages/home/Markdown/plugins/remarkHtmlArtifact'
import { htmlArtifactRequiresUserConsent } from '@renderer/utils/htmlArtifact'
import { Modal, Spin } from 'antd'
import { createContext, lazy, type ReactNode, Suspense, use, useCallback, useMemo, useState } from 'react'

export interface HtmlArtifactPopupSession {
  artifactId: string
  html: string
  title: string
  onSave?: (html: string) => void
  editable: boolean
  kind: HtmlArtifactKind
  zoom: number
}

type HtmlArtifactPopupUpdate = Omit<HtmlArtifactPopupSession, 'zoom'>

export interface HtmlArtifactPopupContextValue {
  approvedInteractiveHtmlById: Readonly<Record<string, string>>
  popupSession: HtmlArtifactPopupSession | null
  approveInteractiveHtml: (artifactId: string, html: string) => void
  openPopup: (session: HtmlArtifactPopupSession) => void
  syncPopup: (update: HtmlArtifactPopupUpdate) => void
  closePopup: () => void
}

const HtmlArtifactPopupContext = createContext<HtmlArtifactPopupContextValue | null>(null)

const HtmlArtifactPopupOutlet = lazy(() => import('./HtmlArtifactsPopup'))

/**
 * c2-40②：弹窗是 `lazy(() => import(...))` 且会连带拉入 CodeMirror。fallback 渲染 `null` 时，
 * 用户点「最大化」后 chunk 未就绪期间是一次显式点击换来零反馈 —— 家规点名的 silent invisibility。
 * 这里给一个真实的 Modal 外壳 + loading 占位。
 */
function HtmlArtifactPopupFallback() {
  return (
    <Modal
      open
      footer={null}
      closable={false}
      centered
      maskClosable={false}
      width={600}
      data-testid="html-artifact-popup-loading"
      styles={{ body: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160 } }}>
      <Spin />
    </Modal>
  )
}

export function useOptionalHtmlArtifactPopupContext(): HtmlArtifactPopupContextValue | null {
  return use(HtmlArtifactPopupContext)
}

export function useHtmlArtifactPopupContext(): HtmlArtifactPopupContextValue {
  const popupContext = useOptionalHtmlArtifactPopupContext()
  if (!popupContext) {
    throw new Error('HTML artifact popup components must be rendered within HtmlArtifactPopupHost')
  }
  return popupContext
}

export function HtmlArtifactPopupHost({ children }: { children: ReactNode }) {
  const [approvedInteractiveHtmlById, setApprovedInteractiveHtmlById] = useState<Record<string, string>>({})
  const [popupSession, setPopupSession] = useState<HtmlArtifactPopupSession | null>(null)
  const approveInteractiveHtml = useCallback((artifactId: string, html: string) => {
    setApprovedInteractiveHtmlById((current) =>
      current[artifactId] === html ? current : { ...current, [artifactId]: html }
    )
  }, [])
  const openPopup = useCallback((session: HtmlArtifactPopupSession) => {
    setPopupSession(session)
  }, [])
  const syncPopup = useCallback((update: HtmlArtifactPopupUpdate) => {
    setPopupSession((current) => {
      if (!current || current.artifactId !== update.artifactId) return current
      if (
        current.html === update.html &&
        current.title === update.title &&
        current.onSave === update.onSave &&
        current.editable === update.editable &&
        current.kind === update.kind
      ) {
        return current
      }
      return { ...current, ...update }
    })
  }, [])
  const closePopup = useCallback(() => {
    // 打开全屏弹窗本身就是显式查看动作（V2 语义）：关闭时把「这个 html 串」记为已批准，
    // 消息内的卡片随之换成交互式预览。
    setPopupSession((current) => {
      if (current && current.kind === 'document' && htmlArtifactRequiresUserConsent(current.html)) {
        approveInteractiveHtml(current.artifactId, current.html)
      }
      return null
    })
  }, [approveInteractiveHtml])
  const contextValue = useMemo<HtmlArtifactPopupContextValue>(
    () => ({
      approvedInteractiveHtmlById,
      popupSession,
      approveInteractiveHtml,
      openPopup,
      syncPopup,
      closePopup
    }),
    [approvedInteractiveHtmlById, approveInteractiveHtml, closePopup, openPopup, popupSession, syncPopup]
  )

  return (
    <HtmlArtifactPopupContext value={contextValue}>
      {children}
      {popupSession ? (
        <Suspense fallback={<HtmlArtifactPopupFallback />}>
          <HtmlArtifactPopupOutlet
            open
            title={popupSession.title}
            html={popupSession.html}
            onSave={popupSession.onSave}
            editable={popupSession.editable}
            interactive={popupSession.kind === 'document' && htmlArtifactRequiresUserConsent(popupSession.html)}
            onClose={closePopup}
          />
        </Suspense>
      ) : null}
    </HtmlArtifactPopupContext>
  )
}
