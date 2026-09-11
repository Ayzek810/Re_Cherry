// don't reorder this file, it's used to initialize the app data dir and
// other which should be run before the main process is ready
// eslint-disable-next-line
import './bootstrap'

import '@main/config'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { replaceDevtoolsFont } from '@main/utils/windowUtil'
import { app, crashReporter } from 'electron'
import installExtension, { REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from 'electron-devtools-installer'
import { isDev, isLinux, isWin } from './constant'

import process from 'node:process'

import { registerIpc } from './ipc'
import { analyticsService } from './services/AnalyticsService'
import { appMenuService } from './services/AppMenuService'
import { configManager } from './services/ConfigManager'
import { nodeTraceService } from './services/NodeTraceService'
import {
  CHERRY_STUDIO_PROTOCOL,
  handleProtocolUrl,
  registerProtocolClient,
  setupAppImageDeepLink
} from './services/ProtocolClient'
import { registerShortcuts } from './services/ShortcutService'
import { TrayService } from './services/TrayService'
import { versionService } from './services/VersionService'
import { windowService } from './services/WindowService'
import { initWebviewHotkeys } from './services/WebviewService'

const logger = loggerService.withContext('MainEntry')

// enable local crash reports
crashReporter.start({
  companyName: 'CherryHQ',
  productName: 'CherryStudio',
  submitURL: '',
  uploadToServer: false
})

/**
 * Disable hardware acceleration if setting is enabled
 */
const disableHardwareAcceleration = configManager.getDisableHardwareAcceleration()
if (disableHardwareAcceleration) {
  app.disableHardwareAcceleration()
}

/**
 * Disable chromium's window animations
 * main purpose for this is to avoid the transparent window flashing when it is shown
 * Know Issue: https://github.com/electron/electron/issues/12130#issuecomment-627198990
 */
if (isWin) {
  app.commandLine.appendSwitch('wm-window-animations-disabled')
}

/**
 * Enable GlobalShortcutsPortal for Linux Wayland Protocol
 * see: https://www.electronjs.org/docs/latest/api/global-shortcut
 */
if (isLinux && process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

/**
 * Set window class and name for Linux
 * This ensures the window manager identifies the app correctly on both X11 and Wayland
 */
if (isLinux) {
  app.commandLine.appendSwitch('class', 'CherryStudio')
  app.commandLine.appendSwitch('name', 'CherryStudio')
}

// DocumentPolicyIncludeJSCallStacksInCrashReports: Enable features for unresponsive renderer js call stacks
// EarlyEstablishGpuChannel,EstablishGpuChannelAsync: Enable features for early establish gpu channel
// speed up the startup time
// https://github.com/microsoft/vscode/pull/241640/files
app.commandLine.appendSwitch(
  'enable-features',
  'DocumentPolicyIncludeJSCallStacksInCrashReports,EarlyEstablishGpuChannel,EstablishGpuChannelAsync'
)
app.on('web-contents-created', (_, webContents) => {
  webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Document-Policy': ['include-js-call-stacks-in-crash-reports']
      }
    })
  })

  webContents.on('unresponsive', async () => {
    // Interrupt execution and collect call stack from unresponsive renderer
    logger.error('Renderer unresponsive start')
    const callStack = await webContents.mainFrame.collectJavaScriptCallStack()
    logger.error(`Renderer unresponsive js call stack\n ${callStack}`)
  })
})

// in production mode, handle uncaught exception and unhandled rejection globally
if (!isDev) {
  // handle uncaught exception
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error)
  })

  // handle unhandled rejection
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`)
  })
}

// Check for single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
} else {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.

  void app.whenReady().then(async () => {
    // Record current version for tracking
    // A preparation for v2 data refactoring
    versionService.recordCurrentVersion()

    initWebviewHotkeys()
    // Set app user model id for windows
    electronApp.setAppUserModelId(import.meta.env.VITE_MAIN_BUNDLE_ID || 'com.kangfenmao.CherryStudio')

    // Mac: Hide dock icon before window creation when launch to tray is set
    const isLaunchToTray = configManager.getLaunchToTray()
    if (isLaunchToTray) {
      app.dock?.hide()
    }

    // Check for backup restore marker and complete restoration (highest priority, before window creation)
    const { BackupManager } = await import('./services/BackupManager')
    await BackupManager.handleStartupRestore()

    const mainWindow = windowService.createMainWindow()

    // 启动 dsh 内核（并行，不阻塞窗口创建；失败仅告警，不影响应用启动）
    import('./kernel').then(async ({ bootKernel }) => {
      try {
        await bootKernel()
      } catch (error) {
        logger.error('Failed to boot dsh kernel', error instanceof Error ? error : new Error(String(error)))
      }
    })

    // 关键接线优先：快捷键与 IPC 是应用可用性的底线，必须排在一切"外观类"初始化之前。
    // 依据（真实事故）：本文件曾把 `new TrayService()` 放在这两行之前，托盘构造抛错
    // （i18n 命名空间被误删 → trayLocale 为 undefined）后，registerShortcuts/registerIpc
    // 被整体跳过，表现为 Ctrl+Space 快捷助手失效、窗口关闭按钮失灵、以及大量
    // "No handler registered" 报错。外观类失败绝不能带走应用的基本可用性。
    registerShortcuts(mainWindow)
    await registerIpc(mainWindow, app)

    // 托盘与 macOS 应用菜单：失败仅告警，不影响应用启动（与内核启动同策略）
    try {
      new TrayService()
    } catch (error) {
      logger.error('Failed to create tray service', error instanceof Error ? error : new Error(String(error)))
    }

    // Setup macOS application menu
    try {
      appMenuService?.setupApplicationMenu()
    } catch (error) {
      logger.error('Failed to setup application menu', error instanceof Error ? error : new Error(String(error)))
    }

    nodeTraceService.init()
    analyticsService.init()

    app.on('activate', function () {
      const mainWindow = windowService.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        windowService.createMainWindow()
      } else {
        windowService.showMainWindow()
      }
    })

    replaceDevtoolsFont(mainWindow)

    // Setup deep link for AppImage on Linux
    await setupAppImageDeepLink()

    if (isDev) {
      // v0.2.4-1：改为按需安装。默认关闭——该扩展从 Chrome 应用商店下载，网络受限环境下
      // 会重试 5 次并抛出 net::ERR_CONNECTION_TIMED_OUT（每次启动白等约 60s 且刷 ERROR 日志）。
      // 需要 React/Redux DevTools 时设置 RC_DEVTOOLS=1（可写入 .env）即可恢复原行为。
      if (process.env.RC_DEVTOOLS === '1') {
        installExtension([REDUX_DEVTOOLS, REACT_DEVELOPER_TOOLS])
          .then((name) => logger.info(`Added Extension:  ${name}`))
          .catch((err) => logger.warn('devtools extension install failed (non-fatal)', err))
      } else {
        logger.debug('devtools extensions skipped (set RC_DEVTOOLS=1 to enable)')
      }
    }
  })

  registerProtocolClient(app)

  // macOS specific: handle protocol when app is already running

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url)
  })

  const handleOpenUrl = (args: string[]) => {
    const url = args.find((arg) => arg.startsWith(CHERRY_STUDIO_PROTOCOL + '://'))
    if (url) handleProtocolUrl(url)
  }

  // for windows to start with url
  handleOpenUrl(process.argv)

  // Listen for second instance
  app.on('second-instance', (_event, argv) => {
    windowService.showMainWindow()

    // Protocol handler for Windows/Linux
    // The commandLine is an array of strings where the last item might be the URL
    handleOpenUrl(argv)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    // 通知渲染进程 flush 持久化状态（原系统关机 handler 的保存职责迁到这里；
    // 窗口 close 时 WindowService 也会发一次，幂等）
    const mainWindow = windowService.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.App_SaveData)
    }
  })

  app.on('will-quit', async () => {
    // 简单的资源清理，不阻塞退出流程
    try {
      await analyticsService.destroy()
    } catch (error) {
      logger.warn('Error cleaning up services:', error as Error)
    }

    // 停止 dsh 内核：dispose 所有插件 fiber（SQLite 连接、事件监听等），
    // 否则这些句柄拖住主进程，应用退不干净
    try {
      const { stopKernel } = await import('./kernel')
      await stopKernel()
    } catch (error) {
      logger.warn('Error stopping dsh kernel:', error as Error)
    }

    // finish the logger
    logger.finish()
  })

  // In this file you can include the rest of your app"s specific main process
  // code. You can also put them in separate files and require them here.
}
