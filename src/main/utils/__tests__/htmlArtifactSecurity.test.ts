/**
 * 交互式 HTML 预览加固的行为级测试（V2 `MainWindowService.test.ts` 的 HTML artifact webviews
 * 四例移植 + session 加固断言）：把关的是「webview 只可能是无 preload 沙箱」与
 * 「专用会话不放行本地/私网请求」两条安全契约。
 */
import { HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX, HTML_ARTIFACT_PREVIEW_PARTITION } from '@shared/utils/htmlArtifact'
import type { BrowserWindow, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { hardenHtmlArtifactPreviewSession, hardenHtmlArtifactWebviews } from '../htmlArtifactSecurity'

type Listener = (...args: unknown[]) => void

function createFakeMainWindow() {
  const listeners = new Map<string, Listener>()
  const webContents = {
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener)
    })
  }
  return {
    window: { webContents } as unknown as BrowserWindow,
    listener: (event: string) => {
      const found = listeners.get(event)
      if (!found) throw new Error(`${event} listener was not registered`)
      return found
    }
  }
}

function createFakePreviewSession() {
  const willDownloadListeners: Listener[] = []
  const beforeRequest = { onBeforeRequest: vi.fn() }
  const session = {
    getUserAgent: vi.fn(() => 'Mozilla/5.0 CherryStudio/1.0.0 Electron/41.0.0 Browser/1.0'),
    setUserAgent: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      if (event === 'will-download') willDownloadListeners.push(listener)
    }),
    webRequest: beforeRequest
  }
  return {
    session: session as unknown as Session,
    mock: session,
    willDownloadListeners
  }
}

describe('hardenHtmlArtifactWebviews', () => {
  it('forces a sandboxed, preload-free guest for the preview partition', () => {
    const { window, listener } = createFakeMainWindow()
    const previewSession = {} as Session
    hardenHtmlArtifactWebviews(window, previewSession)

    const event = { preventDefault: vi.fn() }
    const webPreferences = {
      allowRunningInsecureContent: true,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      preload: '/unsafe/preload.js',
      safeDialogs: false,
      sandbox: false,
      webSecurity: false
    }

    listener('will-attach-webview')(event, webPreferences, {
      partition: HTML_ARTIFACT_PREVIEW_PARTITION,
      src: `${HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX}%3Ch1%3EPreview%3C%2Fh1%3E`
    })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(webPreferences).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      safeDialogs: true,
      sandbox: true,
      webSecurity: true
    })
  })

  it('leaves other partitions untouched', () => {
    const { window, listener } = createFakeMainWindow()
    hardenHtmlArtifactWebviews(window, {} as Session)

    const webPreferences = { nodeIntegration: true, sandbox: false }
    listener('will-attach-webview')({ preventDefault: vi.fn() }, webPreferences, {
      partition: 'persist:webview',
      src: 'https://example.com'
    })

    expect(webPreferences).toEqual({ nodeIntegration: true, sandbox: false })
  })

  it('rejects non-data entry points for the interactive preview partition', () => {
    const { window, listener } = createFakeMainWindow()
    hardenHtmlArtifactWebviews(window, {} as Session)

    const event = { preventDefault: vi.fn() }
    listener('will-attach-webview')(event, {}, {
      partition: HTML_ARTIFACT_PREVIEW_PARTITION,
      src: 'https://example.com'
    })

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('denies guest popups and top-level navigation away from the generated document', () => {
    const { window, listener } = createFakeMainWindow()
    const previewSession = {} as Session
    hardenHtmlArtifactWebviews(window, previewSession)

    const guestListeners = new Map<string, Listener>()
    const guestWebContents = {
      on: vi.fn((event: string, handler: Listener) => {
        guestListeners.set(event, handler)
      }),
      session: previewSession,
      setWindowOpenHandler: vi.fn()
    }

    listener('did-attach-webview')({}, guestWebContents)

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0][0] as () => unknown
    expect(windowOpenHandler()).toEqual({ action: 'deny' })

    const navigationHandler = guestListeners.get('will-navigate')
    if (!navigationHandler) throw new Error('will-navigate listener was not registered')

    const externalNavigation = { preventDefault: vi.fn() }
    navigationHandler(externalNavigation, 'https://example.com')
    expect(externalNavigation.preventDefault).toHaveBeenCalledTimes(1)

    const generatedDocumentNavigation = { preventDefault: vi.fn() }
    navigationHandler(generatedDocumentNavigation, `${HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX}%3Cp%3E`)
    expect(generatedDocumentNavigation.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores guests that do not belong to the preview session', () => {
    const { window, listener } = createFakeMainWindow()
    hardenHtmlArtifactWebviews(window, {} as Session)

    const guestWebContents = {
      on: vi.fn(),
      session: {} as Session,
      setWindowOpenHandler: vi.fn()
    }

    listener('did-attach-webview')({}, guestWebContents)

    expect(guestWebContents.setWindowOpenHandler).not.toHaveBeenCalled()
    expect(guestWebContents.on).not.toHaveBeenCalled()
  })
})

describe('hardenHtmlArtifactPreviewSession', () => {
  it('denies permissions, downloads, local targets, and identifying user-agent tokens', () => {
    const { session, mock, willDownloadListeners } = createFakePreviewSession()
    hardenHtmlArtifactPreviewSession(session)

    expect(mock.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Browser/1.0')
    expect((mock.setPermissionCheckHandler.mock.calls[0][0] as () => boolean)()).toBe(false)

    const permissionCallback = vi.fn()
    ;(mock.setPermissionRequestHandler.mock.calls[0][0] as (a: unknown, b: unknown, cb: (v: boolean) => void) => void)(
      null,
      null,
      permissionCallback
    )
    expect(permissionCallback).toHaveBeenCalledWith(false)

    const downloadEvent = { preventDefault: vi.fn() }
    for (const listener of willDownloadListeners) listener(downloadEvent)
    expect(downloadEvent.preventDefault).toHaveBeenCalled()

    const requestHandler = mock.webRequest.onBeforeRequest.mock.calls[0][1] as (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void
    ) => void

    const publicRequestCallback = vi.fn()
    requestHandler({ url: 'https://example.com/style.css' }, publicRequestCallback)
    expect(publicRequestCallback).toHaveBeenCalledWith({ cancel: false })

    const localRequestCallback = vi.fn()
    requestHandler({ url: 'http://127.0.0.1/private' }, localRequestCallback)
    expect(localRequestCallback).toHaveBeenCalledWith({ cancel: true })

    const fileRequestCallback = vi.fn()
    requestHandler({ url: 'file:///etc/passwd' }, fileRequestCallback)
    expect(fileRequestCallback).toHaveBeenCalledWith({ cancel: true })

    const dataRequestCallback = vi.fn()
    requestHandler({ url: 'data:text/html,<h1>Preview</h1>' }, dataRequestCallback)
    expect(dataRequestCallback).toHaveBeenCalledWith({ cancel: false })
  })
})
