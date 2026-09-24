import fs from 'node:fs'
import { arch } from 'node:os'
import path from 'node:path'

import type { TokenUsageData } from '@cherrystudio/analytics-client'
import { loggerService } from '@logger'
import { isLinux, isPortable, isWin } from '@main/constant'
import { getIpCountry } from '@main/utils/ipService'
import { handleZoomFactor } from '@main/utils/zoom'
import type { SpanEntity, TokenUsage } from '@mcp-trace/trace-core'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { extractPdfText } from '@shared/utils/pdf'
import type { MCPServer, Notification, Shortcut, ThemeMode } from '@types'
import checkDiskSpace from 'check-disk-space'
import type { ProxyConfig } from 'electron'
import { BrowserWindow, dialog, ipcMain, session, shell, webContents } from 'electron'
import fontList from 'font-list'

import { analyticsService } from './services/AnalyticsService'
import appService from './services/AppService'
import BackupManager from './services/BackupManager'
import { configManager } from './services/ConfigManager'
import { ExportService } from './services/ExportService'
import { externalAppsService } from './services/ExternalAppsService'
import { fileStorage as fileManager } from './services/FileStorage'
import FileService from './services/FileSystemService'
import { knowledgeService } from './services/knowledge/KnowledgeService'
import { localModelService } from './services/localModel/localModelService'
import MemoryService from './services/memory/MemoryService'
import { openTraceWindow, setTraceWindowTitle } from './services/NodeTraceService'
import NotificationService from './services/NotificationService'
import * as NutstoreService from './services/NutstoreService'
import { providerKeyStore } from './services/ProviderKeyStore'
import { proxyManager } from './services/ProxyManager'
import { searchService } from './services/SearchService'
import { isSafeExternalUrl } from './services/security'
import { registerShortcuts, registerUniversalShortcuts, unregisterAllShortcuts } from './services/ShortcutService'
import { skillService } from './services/skills/SkillService'
import {
  addEndMessage,
  addStreamMessage,
  bindTopic,
  cleanHistoryTrace,
  cleanLocalData,
  cleanTopic,
  getSpans,
  saveEntity,
  saveSpans,
  tokenUsage
} from './services/SpanCacheService'
import storeSyncService from './services/StoreSyncService'
import { themeService } from './services/ThemeService'
import { setOpenLinkExternal } from './services/WebviewService'
import { windowService } from './services/WindowService'
import { calculateDirectorySize, getResourcePath } from './utils'
import { decrypt } from './utils/aes'
import {
  getCacheDir,
  getConfigDir,
  getFilesDir,
  getNotesDir,
  hasWritePermission,
  isPathInside,
  untildify
} from './utils/file'
import { updateAppDataConfig } from './utils/init'
import { getDeviceType, getHostname } from './utils/system'
import { decompress } from './utils/zip'

const logger = loggerService.withContext('IPC')

const backupManager = new BackupManager()
const exportService = new ExportService()
const memoryService = MemoryService.getInstance()

export async function registerIpc(mainWindow: BrowserWindow, app: Electron.App) {
  const notificationService = new NotificationService()

  const checkMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window does not exist or has been destroyed')
    }
  }

  ipcMain.handle(IpcChannel.App_Info, () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    filesPath: getFilesDir(),
    notesPath: getNotesDir(),
    configPath: getConfigDir(),
    appDataPath: app.getPath('userData'),
    resourcesPath: getResourcePath(),
    logsPath: logger.getLogsDir(),
    arch: arch(),
    isPortable: isWin && 'PORTABLE_EXECUTABLE_DIR' in process.env,
    installPath: path.dirname(app.getPath('exe'))
  }))

  ipcMain.handle(IpcChannel.App_Proxy, async (_, proxy: string, bypassRules?: string) => {
    let proxyConfig: ProxyConfig

    if (proxy === 'system') {
      // system proxy will use the system filter by themselves
      proxyConfig = { mode: 'system' }
    } else if (proxy) {
      proxyConfig = { mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: bypassRules }
    } else {
      proxyConfig = { mode: 'direct' }
    }

    await proxyManager.configureProxy(proxyConfig)
  })

  ipcMain.handle(IpcChannel.App_Reload, () => mainWindow.reload())
  ipcMain.handle(IpcChannel.App_Quit, () => app.quit())
  ipcMain.handle(IpcChannel.Open_Website, (_, url: string) => {
    if (!isSafeExternalUrl(url)) {
      logger.warn(`Blocked shell.openExternal for untrusted URL scheme: ${url}`)
      return
    }
    return shell.openExternal(url)
  })

  // language
  ipcMain.handle(IpcChannel.App_SetLanguage, (_, language) => {
    configManager.setLanguage(language)
  })

  // spell check
  ipcMain.handle(IpcChannel.App_SetEnableSpellCheck, (_, isEnable: boolean) => {
    // disable spell check for all webviews
    const webviews = webContents.getAllWebContents()
    webviews.forEach((webview) => {
      webview.session.setSpellCheckerEnabled(isEnable)
    })
  })

  // spell check languages
  ipcMain.handle(IpcChannel.App_SetSpellCheckLanguages, (_, languages: string[]) => {
    if (languages.length === 0) {
      return
    }
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((window) => {
      window.webContents.session.setSpellCheckerLanguages(languages)
    })
    configManager.set('spellCheckLanguages', languages)
  })

  // launch on boot
  ipcMain.handle(IpcChannel.App_SetLaunchOnBoot, async (_, isLaunchOnBoot: boolean) => {
    await appService.setAppLaunchOnBoot(isLaunchOnBoot)
  })

  // launch to tray
  ipcMain.handle(IpcChannel.App_SetLaunchToTray, (_, isActive: boolean) => {
    configManager.setLaunchToTray(isActive)
  })

  // tray
  ipcMain.handle(IpcChannel.App_SetTray, (_, isActive: boolean) => {
    configManager.setTray(isActive)
  })

  // to tray on close
  ipcMain.handle(IpcChannel.App_SetTrayOnClose, (_, isActive: boolean) => {
    configManager.setTrayOnClose(isActive)
  })

  ipcMain.handle(IpcChannel.App_SetFullScreen, (_, value: boolean): void => {
    mainWindow.setFullScreen(value)
  })

  ipcMain.handle(IpcChannel.App_IsFullScreen, (): boolean => {
    return mainWindow.isFullScreen()
  })

  // Get System Fonts
  ipcMain.handle(IpcChannel.App_GetSystemFonts, async () => {
    try {
      const fonts = await fontList.getFonts()
      return fonts.map((font: string) => font.replace(/^"(.*)"$/, '$1')).filter((font: string) => font.length > 0)
    } catch (error) {
      logger.error('Failed to get system fonts:', error as Error)
      return []
    }
  })

  // Get IP Country
  ipcMain.handle(IpcChannel.App_GetIpCountry, async () => {
    return getIpCountry()
  })

  ipcMain.handle(IpcChannel.Config_Set, (_, key: string, value: any, isNotify: boolean = false) => {
    configManager.set(key, value, isNotify)
  })

  // theme
  ipcMain.handle(IpcChannel.App_SetTheme, (_, theme: ThemeMode) => {
    themeService.setTheme(theme)
  })

  ipcMain.handle(IpcChannel.App_HandleZoomFactor, (_, delta: number, reset: boolean = false) => {
    const windows = BrowserWindow.getAllWindows()
    handleZoomFactor(windows, delta, reset)
    return configManager.getZoomFactor()
  })

  // clear cache
  ipcMain.handle(IpcChannel.App_ClearCache, async () => {
    const sessions = [session.defaultSession, session.fromPartition('persist:webview')]

    try {
      await Promise.all(
        sessions.map(async (session) => {
          await session.clearCache()
          await session.clearStorageData({
            storages: ['cookies', 'filesystem', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
          })
        })
      )
      await fileManager.clearTemp()
      // do not clear logs for now
      // TODO clear logs
      // await fs.writeFileSync(log.transports.file.getFile().path, '')
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to clear cache:', error)
      return { success: false, error: error.message }
    }
  })

  // get cache size
  ipcMain.handle(IpcChannel.App_GetCacheSize, async () => {
    const cachePath = getCacheDir()
    logger.info(`Calculating cache size for path: ${cachePath}`)

    try {
      const sizeInBytes = await calculateDirectorySize(cachePath)
      const sizeInMB = (sizeInBytes / (1024 * 1024)).toFixed(2)
      return `${sizeInMB}`
    } catch (error: any) {
      logger.error(`Failed to calculate cache size for ${cachePath}: ${error.message}`)
      return '0'
    }
  })

  let preventQuitListener: ((event: Electron.Event) => void) | null = null
  ipcMain.handle(IpcChannel.App_SetStopQuitApp, (_, stop: boolean = false, reason: string = '') => {
    if (stop) {
      // Only add listener if not already added
      if (!preventQuitListener) {
        preventQuitListener = (event: Electron.Event) => {
          event.preventDefault()
          void notificationService.sendNotification({
            title: reason,
            message: reason
          } as Notification)
        }
        app.on('before-quit', preventQuitListener)
      }
    } else {
      // Remove listener if it exists
      if (preventQuitListener) {
        app.removeListener('before-quit', preventQuitListener)
        preventQuitListener = null
      }
    }
  })

  // Select app data path
  ipcMain.handle(IpcChannel.App_Select, async (_, options: Electron.OpenDialogOptions) => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(options)
      if (canceled || filePaths.length === 0) {
        return null
      }
      return filePaths[0]
    } catch (error: any) {
      logger.error('Failed to select app data path:', error)
      return null
    }
  })

  ipcMain.handle(IpcChannel.App_HasWritePermission, async (_, filePath: string) => {
    const hasPermission = await hasWritePermission(filePath)
    return hasPermission
  })

  ipcMain.handle(IpcChannel.App_ResolvePath, async (_, filePath: string) => {
    return path.resolve(untildify(filePath))
  })

  // Check if a path is inside another path (proper parent-child relationship)
  ipcMain.handle(IpcChannel.App_IsPathInside, async (_, childPath: string, parentPath: string) => {
    return isPathInside(childPath, parentPath)
  })

  // Set app data path
  ipcMain.handle(IpcChannel.App_SetAppDataPath, async (_, filePath: string) => {
    updateAppDataConfig(filePath)
    app.setPath('userData', filePath)
  })

  ipcMain.handle(IpcChannel.App_GetDataPathFromArgs, () => {
    return process.argv
      .slice(1)
      .find((arg) => arg.startsWith('--new-data-path='))
      ?.split('--new-data-path=')[1]
  })

  ipcMain.handle(IpcChannel.App_FlushAppData, async () => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.session.flushStorageData()
      await w.webContents.session.cookies.flushStore()
      await w.webContents.session.closeAllConnections()
    }

    session.defaultSession.flushStorageData()
    await session.defaultSession.cookies.flushStore()
    await session.defaultSession.closeAllConnections()
  })

  ipcMain.handle(IpcChannel.App_IsNotEmptyDir, async (_, path: string) => {
    return fs.readdirSync(path).length > 0
  })

  // Copy user data to new location
  ipcMain.handle(IpcChannel.App_Copy, async (_, oldPath: string, newPath: string, occupiedDirs: string[] = []) => {
    try {
      await fs.promises.cp(oldPath, newPath, {
        recursive: true,
        filter: (src) => {
          if (occupiedDirs.some((dir) => src.startsWith(path.resolve(dir)))) {
            return false
          }
          return true
        }
      })
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to copy user data:', error)
      return { success: false, error: error.message }
    }
  })

  // Relaunch app
  ipcMain.handle(IpcChannel.App_RelaunchApp, (_, options?: Electron.RelaunchOptions) => {
    // Fix for .AppImage
    if (isLinux && process.env.APPIMAGE) {
      logger.info(`Relaunching app with options: ${process.env.APPIMAGE}`, options)
      // On Linux, we need to use the APPIMAGE environment variable to relaunch
      // https://github.com/electron-userland/electron-builder/issues/1727#issuecomment-769896927
      options = options || {}
      options.execPath = process.env.APPIMAGE
      options.args = options.args || []
      options.args.unshift('--appimage-extract-and-run')
    }

    if (isWin && isPortable) {
      options = options || {}
      options.execPath = process.env.PORTABLE_EXECUTABLE_FILE
      options.args = options.args || []
    }

    // v0.3.2：沙箱 runner 的 node 语义已改为 dsh-subprocess-local 补丁按子进程注入
    // （见 kernel/index.ts 的说明），内核不再设 ambient `ELECTRON_RUN_AS_NODE`。
    // 这里保留防御性剥除：若用户系统环境同名变量存在，`app.relaunch` 继承后重启的
    // 应用会以 **node** 启动而非 Electron 应用。
    delete process.env.ELECTRON_RUN_AS_NODE

    app.relaunch(options)
    app.exit(0)
  })

  // Reset all data (factory reset)
  ipcMain.handle(IpcChannel.App_ResetData, () => backupManager.resetData())

  // notification
  ipcMain.handle(IpcChannel.Notification_Send, async (_, notification: Notification) => {
    await notificationService.sendNotification(notification)
  })

  // zip
  ipcMain.handle(IpcChannel.Zip_Decompress, (_, text: Buffer) => decompress(text))

  // system
  ipcMain.handle(IpcChannel.System_GetDeviceType, getDeviceType)
  ipcMain.handle(IpcChannel.System_GetHostname, getHostname)

  ipcMain.handle(IpcChannel.System_ToggleDevTools, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win && win.webContents.toggleDevTools()
  })

  // backup
  ipcMain.handle(IpcChannel.Backup_Backup, backupManager.backup.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_Restore, backupManager.restore.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_BackupToWebdav, backupManager.backupToWebdav.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_RestoreFromWebdav, backupManager.restoreFromWebdav.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_ListWebdavFiles, backupManager.listWebdavFiles.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_CheckConnection, backupManager.checkConnection.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_CreateDirectory, backupManager.createDirectory.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_DeleteWebdavFile, backupManager.deleteWebdavFile.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_BackupToLocalDir, backupManager.backupToLocalDir.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_RestoreFromLocalBackup, backupManager.restoreFromLocalBackup.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_ListLocalBackupFiles, backupManager.listLocalBackupFiles.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_DeleteLocalBackupFile, backupManager.deleteLocalBackupFile.bind(backupManager))

  // file
  ipcMain.handle(IpcChannel.File_Open, fileManager.open.bind(fileManager))
  ipcMain.handle(IpcChannel.File_OpenPath, fileManager.openPath.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Save, fileManager.save.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Select, fileManager.selectFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Upload, fileManager.uploadFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Clear, fileManager.clear.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Read, fileManager.readFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ReadExternal, fileManager.readExternalFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Delete, fileManager.deleteFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_DeleteDir, fileManager.deleteDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_DeleteExternalFile, fileManager.deleteExternalFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_DeleteExternalDir, fileManager.deleteExternalDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Move, fileManager.moveFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_MoveDir, fileManager.moveDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Rename, fileManager.renameFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_RenameDir, fileManager.renameDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Get, fileManager.getFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SelectFolder, fileManager.selectFolder.bind(fileManager))
  ipcMain.handle(IpcChannel.File_CreateTempFile, fileManager.createTempFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Mkdir, fileManager.mkdir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Write, fileManager.writeFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_WriteWithId, fileManager.writeFileWithId.bind(fileManager))
  // v0.3.3-2：聊天页 generate_image 出图的内容寻址落盘（id 由渲染层按源串 sha256 给出）
  ipcMain.handle(IpcChannel.File_SaveGeneratedImage, fileManager.saveGeneratedImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SaveImage, fileManager.saveImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Base64Image, fileManager.base64Image.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SaveBase64Image, fileManager.saveBase64Image.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SavePastedImage, fileManager.savePastedImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Base64File, fileManager.base64File.bind(fileManager))
  ipcMain.handle(IpcChannel.File_GetPdfInfo, fileManager.pdfPageCount.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Download, fileManager.downloadFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Copy, fileManager.copyFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_BinaryImage, fileManager.binaryImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_OpenWithRelativePath, fileManager.openFileWithRelativePath.bind(fileManager))
  ipcMain.handle(IpcChannel.File_IsTextFile, fileManager.isTextFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_IsDirectory, fileManager.isDirectory.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ListDirectory, fileManager.listDirectory.bind(fileManager))
  ipcMain.handle(IpcChannel.File_GetDirectoryStructure, fileManager.getDirectoryStructure.bind(fileManager))
  // v0.3.3-2 笔记（V1 原样）：FileStorage.validateNotesDirectory 一直在，补回这一层转发
  ipcMain.handle(IpcChannel.File_ValidateNotesDirectory, fileManager.validateNotesDirectory.bind(fileManager))
  ipcMain.handle(IpcChannel.File_CheckFileName, fileManager.fileNameGuard.bind(fileManager))
  ipcMain.handle(IpcChannel.File_StartWatcher, fileManager.startFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_StopWatcher, fileManager.stopFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_PauseWatcher, fileManager.pauseFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ResumeWatcher, fileManager.resumeFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_BatchUploadMarkdown, fileManager.batchUploadMarkdownFiles.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ShowInFolder, fileManager.showInFolder.bind(fileManager))

  // pdf
  ipcMain.handle(IpcChannel.Pdf_ExtractText, (_, data: Uint8Array | ArrayBuffer | string) => extractPdfText(data))

  // fs
  ipcMain.handle(IpcChannel.Fs_Read, FileService.readFile.bind(FileService))
  ipcMain.handle(IpcChannel.Fs_ReadText, FileService.readTextFileWithAutoEncoding.bind(FileService))

  // provider key 加密存储（v0.2.4 K 线）
  ipcMain.handle(IpcChannel.ProviderKeys_GetAll, () => providerKeyStore.getAll())
  ipcMain.handle(IpcChannel.ProviderKeys_Set, (_e, providerId: string, apiKey: string) => {
    providerKeyStore.set(providerId, apiKey)
  })
  ipcMain.handle(IpcChannel.ProviderKeys_Remove, (_e, providerId: string) => {
    providerKeyStore.remove(providerId)
  })

  // export
  ipcMain.handle(IpcChannel.Export_Word, exportService.exportToWord.bind(exportService))

  // open path
  ipcMain.handle(IpcChannel.Open_Path, async (_, path: string) => {
    await shell.openPath(path)
  })

  // shortcuts
  ipcMain.handle(IpcChannel.Shortcuts_Update, (_, shortcuts: Shortcut[]) => {
    configManager.setShortcuts(shortcuts)
    // Refresh shortcuts registration
    if (mainWindow) {
      unregisterAllShortcuts()
      registerShortcuts(mainWindow)
      // 主窗隐藏在托盘/后台时永不获焦，registerShortcuts 的聚焦路径不会执行；
      // 全局键（show_app/mini_window）必须在配置落定后无条件补挂，
      // 否则开机自启+托盘常驻场景下快捷助手要等用户手动打开主界面才能呼出
      if (!mainWindow.isFocused()) {
        registerUniversalShortcuts()
      }
    }
  })

  // memory
  ipcMain.handle(IpcChannel.Memory_Add, (_, messages, config) => memoryService.add(messages, config))
  ipcMain.handle(IpcChannel.Memory_Search, (_, query, config) => memoryService.search(query, config))
  ipcMain.handle(IpcChannel.Memory_List, (_, config) => memoryService.list(config))
  ipcMain.handle(IpcChannel.Memory_Delete, (_, id) => memoryService.delete(id))
  ipcMain.handle(IpcChannel.Memory_Update, (_, id, memory, metadata) => memoryService.update(id, memory, metadata))
  ipcMain.handle(IpcChannel.Memory_Get, (_, memoryId) => memoryService.get(memoryId))
  ipcMain.handle(IpcChannel.Memory_SetConfig, (_, config) => memoryService.setConfig(config))
  ipcMain.handle(IpcChannel.Memory_DeleteUser, (_, userId) => memoryService.deleteUser(userId))
  ipcMain.handle(IpcChannel.Memory_DeleteAllMemoriesForUser, (_, userId) =>
    memoryService.deleteAllMemoriesForUser(userId)
  )
  ipcMain.handle(IpcChannel.Memory_GetUsersList, () => memoryService.getUsersList())
  ipcMain.handle(IpcChannel.Memory_MigrateMemoryDb, () => memoryService.migrateMemoryDb())

  // window
  ipcMain.handle(IpcChannel.Windows_SetMinimumSize, (_, width: number, height: number) => {
    checkMainWindow()
    mainWindow.setMinimumSize(width, height)
  })

  ipcMain.handle(IpcChannel.Windows_ResetMinimumSize, () => {
    checkMainWindow()

    mainWindow.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
    const [width, height] = mainWindow.getSize() ?? [MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT]
    if (width < MIN_WINDOW_WIDTH) {
      mainWindow.setSize(MIN_WINDOW_WIDTH, height)
    }
  })

  ipcMain.handle(IpcChannel.Windows_GetSize, () => {
    checkMainWindow()
    const [width, height] = mainWindow.getSize() ?? [MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT]
    return [width, height]
  })

  // Window Controls
  ipcMain.handle(IpcChannel.Windows_Minimize, () => {
    checkMainWindow()
    mainWindow.minimize()
  })

  ipcMain.handle(IpcChannel.Windows_Maximize, () => {
    checkMainWindow()
    mainWindow.maximize()
  })

  ipcMain.handle(IpcChannel.Windows_Unmaximize, () => {
    checkMainWindow()
    mainWindow.unmaximize()
  })

  ipcMain.handle(IpcChannel.Windows_Close, () => {
    checkMainWindow()
    mainWindow.close()
  })

  ipcMain.handle(IpcChannel.Windows_IsMaximized, () => {
    checkMainWindow()
    return mainWindow.isMaximized()
  })

  // Send maximized state changes to renderer
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send(IpcChannel.Windows_MaximizedChanged, true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send(IpcChannel.Windows_MaximizedChanged, false)
  })

  // VertexAI
  // mini window
  ipcMain.handle(IpcChannel.MiniWindow_Hide, () => windowService.hideMiniWindow())
  ipcMain.handle(IpcChannel.MiniWindow_Close, () => windowService.closeMiniWindow())
  ipcMain.handle(IpcChannel.MiniWindow_SetPin, (_, isPinned) => windowService.setPinMiniWindow(isPinned))

  // aes
  ipcMain.handle(IpcChannel.Aes_Decrypt, (_, encryptedData: string, iv: string, secretKey: string) =>
    decrypt(encryptedData, iv, secretKey)
  )

  // nutstore
  ipcMain.handle(IpcChannel.Nutstore_GetSsoUrl, NutstoreService.getNutstoreSSOUrl.bind(NutstoreService))
  ipcMain.handle(IpcChannel.Nutstore_DecryptToken, (_, token: string) => NutstoreService.decryptToken(token))
  ipcMain.handle(IpcChannel.Nutstore_GetDirectoryContents, (_, token: string, path: string) =>
    NutstoreService.getDirectoryContents(token, path)
  )

  // search window
  ipcMain.handle(IpcChannel.SearchWindow_OpenUrl, async (_, uid: string, url: string) => {
    return await searchService.openUrlInSearchWindow(uid, url)
  })
  // 批次2：刮取窗口显式关闭（上游 LocalSearchProvider finally 依赖；防按 uid 泄漏）
  ipcMain.handle(IpcChannel.SearchWindow_Close, (_, uid: string) => {
    return searchService.closeSearchWindow(uid)
  })

  // 知识库（批次4）：薄转发直调 KnowledgeService（不变量1）；嵌入模型引用只含
  // providerId/modelId/dimensions，主进程自解析 apiHost/apiKey（不跨进程回传密钥）。
  ipcMain.handle(IpcChannel.KnowledgeBase_Create, (_, base: { id: string }) => knowledgeService.createBase(base))
  ipcMain.handle(IpcChannel.KnowledgeBase_Reset, (_, baseId: string) => knowledgeService.resetBase(baseId))
  ipcMain.handle(IpcChannel.KnowledgeBase_Delete, (_, baseId: string) => knowledgeService.deleteBase(baseId))
  ipcMain.handle(
    IpcChannel.KnowledgeBase_Add,
    (
      _,
      payload: {
        base: {
          id: string
          chunkSize?: number
          chunkOverlap?: number
          documentCount?: number
          preprocessProviderId?: string
        }
        item:
          | { kind: 'file'; baseId: string; itemId: string; filePath: string }
          | { kind: 'url'; baseId: string; itemId: string; url: string }
          | { kind: 'note'; baseId: string; itemId: string; text: string }
        embedding: { providerId: string; modelId: string; dimensions?: number }
      }
    ) => knowledgeService.addItem(payload.item, payload.base, payload.embedding)
  )
  ipcMain.handle(IpcChannel.KnowledgeBase_Remove, (_, payload: { baseId: string; uniqueIds: string[] }) =>
    knowledgeService.removeItem(payload.baseId, payload.uniqueIds)
  )
  ipcMain.handle(
    IpcChannel.KnowledgeBase_Search,
    (
      _,
      payload: {
        base: { id: string; chunkSize?: number; chunkOverlap?: number; documentCount?: number }
        embedding: { providerId: string; modelId: string; dimensions?: number }
        query: string
      }
    ) => knowledgeService.search(payload.base, payload.embedding, payload.query)
  )

  // 本地模型（v0.3.2 LocalPaddle）：下载生命周期薄转发 + 默认文档处理服务商推送落点。
  ipcMain.handle(IpcChannel.LocalModel_GetStatus, () => localModelService.getStatus())
  ipcMain.handle(IpcChannel.LocalModel_Download, () => localModelService.download())
  ipcMain.handle(IpcChannel.LocalModel_Cancel, () => localModelService.cancel())
  ipcMain.handle(IpcChannel.LocalModel_Remove, () => localModelService.remove())

  // 技能（批次5）：薄转发直调 SkillService（磁盘 = 真相源；渲染层切片退为投影）。
  ipcMain.handle(IpcChannel.Skill_InstallFromZip, (_, zipFilePath: string) => skillService.installFromZip(zipFilePath))
  ipcMain.handle(IpcChannel.Skill_InstallFromDirectory, (_, directoryPath: string) =>
    skillService.installFromDirectory(directoryPath)
  )
  ipcMain.handle(IpcChannel.Skill_InstallFromUrl, (_, url: string) => skillService.installFromUrl(url))
  ipcMain.handle(IpcChannel.Skill_Uninstall, (_, folderName: string) => skillService.uninstall(folderName))
  ipcMain.handle(IpcChannel.Skill_List, () => skillService.list())

  // MCP 设置页通道（批次3 契约；v0.3.3-1 补注册）：preload 桥、渲染层 mcpApi、MCPService 方法
  // 三层本已齐备，唯独主进程 handler 与日志事件转发缺失——设置页读版本/工具/日志一律报
  // "No handler registered for 'mcp:*'"（日志噪音 + 功能不可用）。服务实例按内核同款动态导入，
  // 避免在 app ready 前就把 MCP 客户端层实例化。
  {
    const { mcpService } = await import('./services/mcp/MCPService')
    const asServer = (value: unknown) => value as MCPServer
    const asOptionalServer = (value: unknown) => value as MCPServer | undefined

    ipcMain.handle(IpcChannel.Mcp_ListTools, (_, server) => mcpService.listTools(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_ListPrompts, (_, server) => mcpService.listPrompts(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_ListResources, (_, server) => mcpService.listResources(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_GetServerVersion, (_, server) => mcpService.getServerVersion(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_GetServerLogs, (_, server) => mcpService.getServerLogs(asOptionalServer(server)))
    ipcMain.handle(IpcChannel.Mcp_RestartServer, (_, server) => mcpService.restartServer(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_StopServer, (_, server) => mcpService.stopServer(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_RemoveServer, (_, server) => mcpService.removeServer(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_CheckConnectivity, (_, server) => mcpService.checkConnectivity(asServer(server)))

    // 服务器日志事件（主 → 渲染）：MCPService 只维护回调注册表，转发由调用方接线。
    mcpService.onServerLog((log) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannel.Mcp_ServerLog, log)
      }
    })
  }

  // webview
  ipcMain.handle(IpcChannel.Webview_SetOpenLinkExternal, (_, webviewId: number, isExternal: boolean) =>
    setOpenLinkExternal(webviewId, isExternal)
  )
  ipcMain.handle(IpcChannel.Webview_SetSpellCheckEnabled, (_, webviewId: number, isEnable: boolean) => {
    const webview = webContents.fromId(webviewId)
    if (!webview) return
    webview.session.setSpellCheckerEnabled(isEnable)
  })

  // Webview print and save handlers
  ipcMain.handle(IpcChannel.Webview_PrintToPDF, async (_, webviewId: number) => {
    const { printWebviewToPDF } = await import('./services/WebviewService')
    return await printWebviewToPDF(webviewId)
  })

  ipcMain.handle(IpcChannel.Webview_SaveAsHTML, async (_, webviewId: number) => {
    const { saveWebviewAsHTML } = await import('./services/WebviewService')
    return await saveWebviewAsHTML(webviewId)
  })

  // store sync
  storeSyncService.registerIpcHandler()

  ipcMain.handle(IpcChannel.App_QuoteToMain, (_, text: string) => windowService.quoteToMainWindow(text))

  ipcMain.handle(IpcChannel.App_SetDisableHardwareAcceleration, (_, isDisable: boolean) => {
    configManager.setDisableHardwareAcceleration(isDisable)
  })
  ipcMain.handle(IpcChannel.App_SetUseSystemTitleBar, (_, isActive: boolean) => {
    configManager.setUseSystemTitleBar(isActive)
  })
  ipcMain.handle(IpcChannel.TRACE_SAVE_DATA, (_, topicId: string) => saveSpans(topicId))
  ipcMain.handle(IpcChannel.TRACE_GET_DATA, (_, topicId: string, traceId: string, modelName?: string) =>
    getSpans(topicId, traceId, modelName)
  )
  ipcMain.handle(IpcChannel.TRACE_SAVE_ENTITY, (_, entity: SpanEntity) => saveEntity(entity))
  ipcMain.handle(IpcChannel.TRACE_BIND_TOPIC, (_, topicId: string, traceId: string) => bindTopic(traceId, topicId))
  ipcMain.handle(IpcChannel.TRACE_CLEAN_TOPIC, (_, topicId: string, traceId?: string) => cleanTopic(topicId, traceId))
  ipcMain.handle(IpcChannel.TRACE_TOKEN_USAGE, (_, spanId: string, usage: TokenUsage) => tokenUsage(spanId, usage))
  ipcMain.handle(IpcChannel.TRACE_CLEAN_HISTORY, (_, topicId: string, traceId: string, modelName?: string) =>
    cleanHistoryTrace(topicId, traceId, modelName)
  )
  ipcMain.handle(
    IpcChannel.TRACE_OPEN_WINDOW,
    (_, topicId: string, traceId: string, autoOpen?: boolean, modelName?: string) =>
      openTraceWindow(topicId, traceId, autoOpen, modelName)
  )
  ipcMain.handle(IpcChannel.TRACE_SET_TITLE, (_, title: string) => setTraceWindowTitle(title))
  ipcMain.handle(IpcChannel.TRACE_ADD_END_MESSAGE, (_, spanId: string, modelName: string, message: string) =>
    addEndMessage(spanId, modelName, message)
  )
  ipcMain.handle(IpcChannel.TRACE_CLEAN_LOCAL_DATA, () => cleanLocalData())
  ipcMain.handle(
    IpcChannel.TRACE_ADD_STREAM_MESSAGE,
    (_, spanId: string, modelName: string, context: string, msg: any) =>
      addStreamMessage(spanId, modelName, context, msg)
  )

  ipcMain.handle(IpcChannel.App_GetDiskInfo, async (_, directoryPath: string) => {
    try {
      const diskSpace = await checkDiskSpace(directoryPath) // { free, size } in bytes
      logger.debug('disk space', diskSpace)
      const { free, size } = diskSpace
      return {
        free,
        size
      }
    } catch (error) {
      logger.error('check disk space error', error as Error)
      return null
    }
  })

  // ExternalApps
  ipcMain.handle(IpcChannel.ExternalApps_DetectInstalled, () => externalAppsService.detectInstalledApps())

  ipcMain.handle(IpcChannel.APP_CrashRenderProcess, () => {
    mainWindow.webContents.forcefullyCrashRenderer()
  })

  // Analytics
  ipcMain.handle(IpcChannel.Analytics_TrackTokenUsage, (_, data: TokenUsageData) =>
    analyticsService.trackTokenUsage(data)
  )
}
