import { loggerService } from '@logger'
import { TopView } from '@renderer/components/TopView'
import { useTheme } from '@renderer/context/ThemeProvider'
import { ThemeMode } from '@renderer/types'
import { Button, Modal, Spin, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('PrivacyPopup')

const WebViewContainer = styled.div`
  position: relative;
  width: 100%;
  height: min(500px, calc(85vh - 132px));
  overflow: hidden;

  webview {
    width: 100%;
    height: 100%;
    border: none;
    background: transparent;
  }
`

/** 正文就绪前不能是空白 body，否则用户在从未看到内容的弹窗上完成「接受」。 */
const StatusOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  background: var(--color-background);
  text-align: center;
  padding: 24px;
`

interface ShowParams {
  title?: string
  acceptButtonText?: string
  showDeclineButton?: boolean
  force?: boolean
  quitOnDecline?: boolean
  modal?: boolean
  onAccepted?: () => void
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({
  title,
  acceptButtonText,
  showDeclineButton,
  quitOnDecline,
  modal = false,
  onAccepted,
  resolve
}) => {
  const [open, setOpen] = useState(true)
  const [privacyUrl, setPrivacyUrl] = useState<string>('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retryToken, setRetryToken] = useState(0)
  const webviewRef = useRef<HTMLElement | null>(null)
  const resolvedRef = useRef(false)
  const { theme } = useTheme()
  const { i18n, t } = useTranslation()
  const shouldShowDeclineButton = !modal && (showDeclineButton ?? true)
  const shouldQuitOnDecline = quitOnDecline ?? !modal

  const getTitle = () => {
    if (title) return title
    return t('privacy_policy.title')
  }

  const resolveOnce = useCallback(
    (data: { accepted: boolean }) => {
      if (resolvedRef.current) {
        return
      }

      resolvedRef.current = true
      resolve(data)
    },
    [resolve]
  )

  const handleAccept = () => {
    setOpen(false)
    localStorage.setItem('privacy-popup-accepted', 'true')
    onAccepted?.()
    resolveOnce({ accepted: true })
  }

  const handleDecline = () => {
    setOpen(false)
    if (shouldQuitOnDecline) {
      void window.api.quit()
    }
    resolveOnce({ accepted: false })
  }

  useEffect(() => {
    let cancelled = false
    const resolvePrivacyUrl = async () => {
      setLoadState('loading')
      try {
        const { appPath } = await window.api.getAppInfo()
        const isChinese = i18n.language.startsWith('zh')
        const htmlFile = isChinese ? 'privacy-zh.html' : 'privacy-en.html'
        const url = `file://${appPath}/resources/cherry-studio/${htmlFile}?theme=${theme === ThemeMode.dark ? 'dark' : 'light'}`
        if (cancelled) return
        setPrivacyUrl(url)
      } catch (error) {
        // `runAsyncFunction` 不 catch，`getAppInfo()` reject 会让 body 永久空白，
        // 而「我已知晓」照样可点。这里显式记账成错误态并给出重试。
        logger.error('Failed to resolve the privacy policy URL:', error as Error)
        if (!cancelled) setLoadState('error')
      }
    }
    void resolvePrivacyUrl()
    return () => {
      cancelled = true
    }
  }, [theme, i18n.language, retryToken])

  // webview 的加载结果决定正文是否真的可见。
  useEffect(() => {
    const element = webviewRef.current
    if (!element || !privacyUrl) return

    const handleFinished = () => setLoadState('ready')
    const handleFailed = () => setLoadState('error')

    element.addEventListener('did-finish-load', handleFinished)
    element.addEventListener('did-fail-load', handleFailed)

    return () => {
      element.removeEventListener('did-finish-load', handleFinished)
      element.removeEventListener('did-fail-load', handleFailed)
    }
  }, [privacyUrl])

  PrivacyPopup.hide = () => setOpen(false)

  return (
    <Modal
      title={getTitle()}
      open={open}
      onCancel={shouldShowDeclineButton ? handleDecline : undefined}
      transitionName=""
      maskTransitionName=""
      centered
      closable={false}
      maskClosable={false}
      styles={{
        content: { maxHeight: '85vh', overflow: 'hidden' },
        header: { paddingLeft: 20 },
        body: { paddingLeft: 20, overflow: 'hidden' }
      }}
      width={900}
      footer={[
        shouldShowDeclineButton && (
          <Button key="decline" onClick={handleDecline}>
            {t('common.decline')}
          </Button>
        ),
        <Button key="accept" type="primary" onClick={handleAccept} disabled={loadState !== 'ready'}>
          {acceptButtonText ?? t('common.i_know')}
        </Button>
      ].filter(Boolean)}>
      <WebViewContainer>
        {privacyUrl && (
          <webview
            ref={(element) => {
              webviewRef.current = element as unknown as HTMLElement | null
            }}
            src={privacyUrl}
            style={{ width: '100%', height: '100%' }}
          />
        )}
        {loadState !== 'ready' && (
          <StatusOverlay data-testid="privacy-popup-status">
            {loadState === 'error' ? (
              <>
                <Typography.Text type="secondary">{t('error.unknown')}</Typography.Text>
                <Button
                  size="small"
                  data-testid="privacy-popup-retry"
                  onClick={() => {
                    setPrivacyUrl('')
                    setRetryToken((prev) => prev + 1)
                  }}>
                  {t('common.retry')}
                </Button>
              </>
            ) : (
              <Spin size="small" />
            )}
          </StatusOverlay>
        )}
      </WebViewContainer>
    </Modal>
  )
}

const TopViewKey = 'PrivacyPopup'

/** 行为测试用的具名导出（与 `BackupPopupContainer` 同形）。 */
export { PopupContainer as PrivacyPopupContainer }

export default class PrivacyPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static async show(props?: ShowParams) {
    const accepted = localStorage.getItem('privacy-popup-accepted')

    if (accepted && !props?.force) {
      return
    }

    return new Promise<{ accepted: boolean }>((resolve) => {
      TopView.show(
        <PopupContainer
          {...(props || {})}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
