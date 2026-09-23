import type { HtmlArtifactKind } from '@renderer/pages/home/Markdown/plugins/remarkHtmlArtifact'
import { htmlArtifactRequiresUserConsent } from '@renderer/utils/htmlArtifact'
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
        <Suspense fallback={null}>
          <HtmlArtifactPopupOutlet
            open
            title={popupSession.title}
            html={popupSession.html}
            onSave={popupSession.onSave}
            interactive={
              popupSession.kind === 'document' && htmlArtifactRequiresUserConsent(popupSession.html)
            }
            onClose={closePopup}
          />
        </Suspense>
      ) : null}
    </HtmlArtifactPopupContext>
  )
}
