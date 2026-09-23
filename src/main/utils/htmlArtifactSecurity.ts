/**
 * HTML 工件交互式预览的主进程加固（V2 `MainWindowService.setupHtmlArtifactPreviewSession` /
 * `setupHtmlArtifactWebviews` 的 fork 形态）：专用 partition 会话禁权限、禁下载、请求白名单，
 * webview 挂载时删 preload 并强制沙箱。函数体逐字移植，仅把 session/window 由服务字段改为
 * 传入参数（fork 的 WindowService 无 BaseService 生命周期容器，亦便于单测注入）。
 */
import { HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX, HTML_ARTIFACT_PREVIEW_PARTITION } from '@shared/utils/htmlArtifact'
import type { BrowserWindow, Session } from 'electron'

import { isAllowedHtmlArtifactRequest } from './htmlArtifactRequest'

/**
 * 锁定交互式预览会话：去掉可识别的应用/Electron UA 尾巴、拒绝一切权限请求、禁止下载，
 * 并只放行 {@link isAllowedHtmlArtifactRequest} 白名单内的请求（data:/blob:/公网 http(s)）。
 */
export function hardenHtmlArtifactPreviewSession(previewSession: Session): void {
  const handleWillDownload = (event: Electron.Event) => event.preventDefault()
  const userAgent = previewSession
    .getUserAgent()
    .replace(/CherryStudio\/\S+\s/, '')
    .replace(/Electron\/\S+\s/, '')

  previewSession.setUserAgent(userAgent)
  previewSession.setPermissionCheckHandler(() => false)
  previewSession.setPermissionRequestHandler((_, __, callback) => callback(false))
  previewSession.on('will-download', handleWillDownload)
  previewSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedHtmlArtifactRequest(details.url) })
  })
}

/**
 * 加固主窗口上的交互式预览 webview：只接受专用 partition + data: 入口，
 * 强制无 preload 的沙箱化 webPreferences；挂载后拒绝弹窗、只允许留在生成文档内。
 */
export function hardenHtmlArtifactWebviews(mainWindow: BrowserWindow, previewSession: Session): void {
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== HTML_ARTIFACT_PREVIEW_PARTITION) return

    if (!params.src.startsWith(HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.safeDialogs = true
  })

  mainWindow.webContents.on('did-attach-webview', (_, webContents) => {
    if (webContents.session !== previewSession) return

    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(HTML_ARTIFACT_PREVIEW_DATA_URL_PREFIX)) {
        event.preventDefault()
      }
    })
  })
}
