import type { TokenUsageData } from '@cherrystudio/analytics-client'
import { electronAPI } from '@electron-toolkit/preload'
import type { SpanEntity, TokenUsage } from '@mcp-trace/trace-core'
import type { SpanContext } from '@opentelemetry/api'
import type { LogLevel, LogSourceWithContext } from '@shared/config/logger'
import type { FileChangeEvent, WebviewKeyEvent } from '@shared/config/types'
import type { WorkModeApprovalTier } from '@shared/config/workMode'
import type { ExternalAppInfo } from '@shared/externalApp/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { Notification } from '@types'
import type {
  AddMemoryOptions,
  AssistantMessage,
  FileMetadata,
  MemoryConfig,
  MemoryListOptions,
  MemorySearchOptions,
  Shortcut,
  ThemeMode,
  WebDavConfig
} from '@types'
import type { OpenDialogOptions } from 'electron'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import type { CreateDirectoryOptions } from 'webdav'

/**
 * 流式补全终态事件的宽限期（毫秒，与内核无关，纯 preload 侧兜底）：终态事件与 invoke 回复分走两条通道，
 * 回复先到时必须再多等一会儿才能让已排队的 done/error 送达（详见 `dshStreamComplete`）。超时即摘监听。
 */
const STREAM_TERMINAL_GRACE_MS = 2000

type DirectoryListOptions = {
  recursive?: boolean
  maxDepth?: number
  includeHidden?: boolean
  includeFiles?: boolean
  includeDirectories?: boolean
  maxEntries?: number
  searchPattern?: string
}

export function tracedInvoke(channel: string, spanContext: SpanContext | undefined, ...args: any[]) {
  if (spanContext) {
    const data = { type: 'trace', context: spanContext }
    return ipcRenderer.invoke(channel, ...args, data)
  }
  return ipcRenderer.invoke(channel, ...args)
}

// Custom APIs for renderer
const api = {
  dshSyncProviders: (providers: unknown[]) => ipcRenderer.invoke(IpcChannel.Dsh_SyncProviders, providers),
  dshSyncImageDescriber: (config: { provider: string; model: string; prompt: string } | null) =>
    ipcRenderer.invoke(IpcChannel.Dsh_SyncImageDescriber, config),
  dshSyncWebSearch: (config: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_SyncWebSearch, config),
  dshSyncMcpServers: (servers: unknown[]) => ipcRenderer.invoke(IpcChannel.Dsh_SyncMcpServers, servers),
  dshSyncPreprocess: (providers: unknown[]) => ipcRenderer.invoke(IpcChannel.Dsh_SyncPreprocess, providers),
  // 编码助手（v0.3.4-1）：受管 Web UI 工具生命周期 + 状态广播订阅（薄转发）。
  codeCli: {
    deepseekHarness: {
      start: (input: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_Start, input),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_Stop),
      // 批次4a：渲染层订阅缝（useCodeCliStatus）的"立即拉当前值"通道。
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_GetStatus),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_DeepseekHarness_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_DeepseekHarness_Status, listener)
        }
      }
    },
    // Hermes Dashboard（批次1 收尾）：生命周期 + 状态广播订阅（照 deepseekHarness 写法）；
    // readConfig/writeConfig 为 code_cli 配置读写通道（V2 经 zod 路由 ipcApi.request，
    // fork 摊平为直连通道，入参校验在主进程 ipc.ts）。
    hermesDashboard: {
      // fork 缝（批次4a）：V2 zod schema 的 hermes_dashboard.start 入参为 z.void()，形参保形
      // 为可选（fork 主进程 handler 不消费入参）。
      start: (input?: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_HermesDashboard_Start, input),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_HermesDashboard_Stop),
      // 批次4a：同 deepseekHarness.getStatus。
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_HermesDashboard_GetStatus),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_HermesDashboard_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_HermesDashboard_Status, listener)
        }
      }
    },
    readConfig: (targets: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_ReadConfig, targets),
    writeConfig: (payload: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_WriteConfig, payload),
    // 受管 CLI 安装器（批次2）：装卸/快照/最新版本 + 变化广播订阅（照 onStatus 写法）。
    binary: {
      install: (name: string) => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_Install, name),
      remove: (name: string) => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_Remove, name),
      snapshots: () => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_Snapshots),
      latestVersions: () => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_LatestVersions),
      onChanged: (callback: () => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent) => callback()
        ipcRenderer.on(IpcChannel.CodeCli_Binary_Changed, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_Binary_Changed, listener)
        }
      },
      // v0.3.4-2：安装步骤进度订阅（载荷 {tool, step}，step 为 i18n 键尾）。
      onInstallProgress: (callback: (payload: { tool: string; step: string }) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: { tool: string; step: string }) =>
          callback(payload)
        ipcRenderer.on(IpcChannel.CodeCli_Binary_InstallProgress, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_Binary_InstallProgress, listener)
        }
      }
    },
    // 统一网关（批次3）：生命周期 + LAN 开关 + 配置部分更新 + 状态广播订阅
    //（照 deepseekHarness 写法；syncConfig 为 {enabled?, port?, host?} 部分更新，
    // 主进程先持久化再收敛）。
    apiGateway: {
      start: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_Start),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_Stop),
      restart: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_Restart),
      setLanEnabled: (enabled: boolean) => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_LanSetEnabled, enabled),
      syncConfig: (partial: { enabled?: boolean; port?: number; host?: string }) =>
        ipcRenderer.invoke(IpcChannel.CodeCli_SyncGatewayConfig, partial),
      // 批次4a：立即拉当前运行态（载荷 {running, lanRunning?, port?} 同 Status 广播）。
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_GetStatus),
      // 批次5：网关配置读取（host/port/apiKey|null/running）——合成网关 provider 数据源。
      getConfig: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_GetConfig),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_ApiGateway_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_ApiGateway_Status, listener)
        }
      }
    }
  },
  webSearch: {
    check: (providerId: string) => ipcRenderer.invoke(IpcChannel.WebSearch_Check, providerId)
  },
  // MCP 设置页通道（批次3）：与主进程 MCPService 一一对应的薄转发（invoke）+ 日志事件订阅。
  mcp: {
    listTools: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_ListTools, server),
    listPrompts: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_ListPrompts, server),
    listResources: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_ListResources, server),
    getServerVersion: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_GetServerVersion, server),
    getServerLogs: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_GetServerLogs, server),
    restartServer: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_RestartServer, server),
    stopServer: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_StopServer, server),
    removeServer: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_RemoveServer, server),
    checkConnectivity: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_CheckConnectivity, server),
    onServerLog: (callback: (log: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, log: unknown) => callback(log)
      ipcRenderer.on(IpcChannel.Mcp_ServerLog, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.Mcp_ServerLog, listener)
      }
    }
  },
  // 知识库通道（批次4）：主进程 KnowledgeService 薄转发（嵌入引用只含 id，密钥主进程自解析）。
  knowledgeBase: {
    create: (base: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Create, base),
    reset: (baseId: string) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Reset, baseId),
    delete: (baseId: string) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Delete, baseId),
    add: (payload: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Add, payload),
    remove: (payload: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Remove, payload),
    search: (payload: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Search, payload)
  },
  // 本地模型（v0.3.2 LocalPaddle）：下载生命周期；进度由渲染层轮询 getStatus。
  localModel: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.LocalModel_GetStatus),
    download: () => ipcRenderer.invoke(IpcChannel.LocalModel_Download),
    cancel: () => ipcRenderer.invoke(IpcChannel.LocalModel_Cancel),
    remove: () => ipcRenderer.invoke(IpcChannel.LocalModel_Remove)
  },
  // 技能通道（批次5）：主进程 SkillService 薄转发（磁盘 = 真相源，列表全量投影）。
  skills: {
    installFromZip: (zipFilePath: string) => ipcRenderer.invoke(IpcChannel.Skill_InstallFromZip, zipFilePath),
    installFromDirectory: (directoryPath: string) =>
      ipcRenderer.invoke(IpcChannel.Skill_InstallFromDirectory, directoryPath),
    installFromUrl: (url: string) => ipcRenderer.invoke(IpcChannel.Skill_InstallFromUrl, url),
    uninstall: (folderName: string) => ipcRenderer.invoke(IpcChannel.Skill_Uninstall, folderName),
    list: () => ipcRenderer.invoke(IpcChannel.Skill_List)
  },
  dshStreamSmoke: (payload: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_StreamSmoke, payload),
  dshComplete: (payload: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_Complete, payload),
  dshStreamComplete: (payload: unknown, onEvent: (data: unknown) => void) => {
    const requestId = (payload as { requestId: string }).requestId
    let terminal = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const listener = (_event: Electron.IpcRendererEvent, data: { requestId?: string; type?: string }) => {
      if (data?.requestId !== requestId) return
      if (data.type === 'done' || data.type === 'error') {
        terminal = true
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer)
          graceTimer = undefined
        }
      }
      onEvent(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_CompletionEvent, listener)
    const off = () => ipcRenderer.off(IpcChannel.Dsh_CompletionEvent, listener)
    // v0.3.3-1 修复（"快速助手完成输出后不自动停止"）：这条轻通路（不建内核会话）的终态事件（done/error）
    // 与 invoke 回复走的是**两条不同通道**，会赛跑——主进程在 `send(done)` 之后立刻 return，回复常常先被
    // 渲染层处理，于是 `.finally(off)` 在终态事件排队期间就把监听摘掉了：正文 delta 早已送达、末条 done
    // 永远到不了 ⇒ 消息停在 processing、块停在 streaming、"按 ESC 暂停"一直挂着（真机与隔离实例探针都能复现）。
    // 现在回复落地后**先等终态事件**（最多 STREAM_TERMINAL_GRACE_MS），拿到即摘；超时才兜底摘掉。
    return ipcRenderer.invoke(IpcChannel.Dsh_StreamComplete, payload).finally(() => {
      if (terminal) {
        off()
        return
      }
      graceTimer = setTimeout(off, STREAM_TERMINAL_GRACE_MS)
    })
  },
  dshLightImage: (payload: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_LightImage, payload),
  dshLightImageAbort: (requestId: string) => ipcRenderer.invoke(IpcChannel.Dsh_LightImageAbort, requestId),
  // fork 缝：流式补全的真取消缝（requestId 配对；主进程 `requestId → AbortController`）。
  dshStreamAbort: (requestId: string) => ipcRenderer.invoke(IpcChannel.Dsh_StreamAbort, requestId),

  dshTopicList: () => ipcRenderer.invoke(IpcChannel.Dsh_TopicList),
  dshTopicCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_TopicCreate, input),
  dshTopicRename: (id: string, name: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicRename, id, name),
  dshTopicDelete: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicDelete, id),
  dshTopicDestroyTurns: (id: string, anchorUserSeqs: number[]) =>
    ipcRenderer.invoke(IpcChannel.Dsh_TopicDestroyTurns, id, anchorUserSeqs),
  dshTopicOpen: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicOpen, id),
  dshTopicFork: (topicId: string, anchorUserMessageSeq: number) =>
    ipcRenderer.invoke(IpcChannel.Dsh_TopicFork, topicId, anchorUserMessageSeq),
  dshTopicBranches: (rootTopicId: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicBranches, rootTopicId),
  dshTopicSend: (
    id: string,
    text: string,
    options?: {
      reasoningEffort?: string
      builtinTools?: string[]
      externalTools?: string[]
      tier?: WorkModeApprovalTier
      /** 随消息附带的图片（base64，v0.3.1 识图通道；内核准入后并入用户消息内容块）。 */
      images?: Array<{ mediaType: string; data: string; name?: string }>
      /** 网络搜索（批次2）：本轮 web_search 的提供商（与 topics.TopicSendOptions 逐字段对齐）。 */
      webSearch?: { providerId: string }
      /** 聊天生图（批次5）：本轮 generate_image 工具的绘画模型（与 topics.TopicSendOptions 逐字段对齐）。 */
      generateImage?: { providerId: string; modelId: string }
      /** 知识库检索（批次4）：本轮可检索库清单。 */
      knowledgeBases?: Array<{
        id: string
        chunkSize?: number
        chunkOverlap?: number
        documentCount?: number
        threshold?: number
        embedding: { providerId: string; modelId: string; dimensions: number }
      }>
      /** 技能（批次5）：本轮可读技能清单。 */
      skills?: Array<{
        id: string
        folderName: string
        name: string
        description: string
        contentHash?: string
        author?: string | null
      }>
      /** 文档阅读（批次6）：本轮附件文档清单。 */
      documents?: Array<{ name: string; path: string; ext?: string }>
    }
  ) => ipcRenderer.invoke(IpcChannel.Dsh_TopicSend, id, text, options),
  /** 内核图片附件回放同步：按 ref 读回核验字节并落入文件仓（确定性 id，幂等）。 */
  dshAttachmentSync: (ref: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }) => ipcRenderer.invoke(IpcChannel.Dsh_AttachmentSync, ref),
  dshTopicStop: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicStop, id),
  dshTopicRunning: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicRunning, id),
  dshTopicEvents: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicEvents, id),
  dshTopicGet: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicGet, id),
  dshApprovalDecide: (decision: { requestId: string; behavior: 'allow' | 'deny' }) =>
    ipcRenderer.invoke(IpcChannel.Dsh_ApprovalDecide, decision),
  dshQuestionAnswer: (answer: { requestId: string; answers: { id: string; selected: string[]; custom?: string }[] }) =>
    ipcRenderer.invoke(IpcChannel.Dsh_QuestionAnswer, answer),
  dshOnApprovalRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_ApprovalRequest, listener)
    return () => ipcRenderer.off(IpcChannel.Dsh_ApprovalRequest, listener)
  },
  dshOnQuestionRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_QuestionRequest, listener)
    return () => ipcRenderer.off(IpcChannel.Dsh_QuestionRequest, listener)
  },
  dshSearchMessages: (terms: string[]) => ipcRenderer.invoke(IpcChannel.Dsh_SearchMessages, terms),
  dshOnSessionEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_SessionEvent, listener)
    return () => ipcRenderer.off(IpcChannel.Dsh_SessionEvent, listener)
  },
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.App_Info),
  getDiskInfo: (directoryPath: string): Promise<{ free: number; size: number } | null> =>
    ipcRenderer.invoke(IpcChannel.App_GetDiskInfo, directoryPath),
  reload: () => ipcRenderer.invoke(IpcChannel.App_Reload),
  quit: () => ipcRenderer.invoke(IpcChannel.App_Quit),
  setProxy: (proxy: string | undefined, bypassRules?: string) =>
    ipcRenderer.invoke(IpcChannel.App_Proxy, proxy, bypassRules),
  setLanguage: (lang: string) => ipcRenderer.invoke(IpcChannel.App_SetLanguage, lang),
  setEnableSpellCheck: (isEnable: boolean) => ipcRenderer.invoke(IpcChannel.App_SetEnableSpellCheck, isEnable),
  setSpellCheckLanguages: (languages: string[]) => ipcRenderer.invoke(IpcChannel.App_SetSpellCheckLanguages, languages),
  setLaunchOnBoot: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetLaunchOnBoot, isActive),
  setLaunchToTray: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetLaunchToTray, isActive),
  setTray: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetTray, isActive),
  setTrayOnClose: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetTrayOnClose, isActive),
  setTheme: (theme: ThemeMode) => ipcRenderer.invoke(IpcChannel.App_SetTheme, theme),
  handleZoomFactor: (delta: number, reset: boolean = false) =>
    ipcRenderer.invoke(IpcChannel.App_HandleZoomFactor, delta, reset),
  select: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke(IpcChannel.App_Select, options),
  hasWritePermission: (path: string) => ipcRenderer.invoke(IpcChannel.App_HasWritePermission, path),
  resolvePath: (path: string) => ipcRenderer.invoke(IpcChannel.App_ResolvePath, path),
  isPathInside: (childPath: string, parentPath: string) =>
    ipcRenderer.invoke(IpcChannel.App_IsPathInside, childPath, parentPath),
  setAppDataPath: (path: string) => ipcRenderer.invoke(IpcChannel.App_SetAppDataPath, path),
  getDataPathFromArgs: () => ipcRenderer.invoke(IpcChannel.App_GetDataPathFromArgs),
  copy: (oldPath: string, newPath: string, occupiedDirs: string[] = []) =>
    ipcRenderer.invoke(IpcChannel.App_Copy, oldPath, newPath, occupiedDirs),
  setStopQuitApp: (stop: boolean, reason: string) => ipcRenderer.invoke(IpcChannel.App_SetStopQuitApp, stop, reason),
  flushAppData: () => ipcRenderer.invoke(IpcChannel.App_FlushAppData),
  isNotEmptyDir: (path: string) => ipcRenderer.invoke(IpcChannel.App_IsNotEmptyDir, path),
  relaunchApp: (options?: Electron.RelaunchOptions) => ipcRenderer.invoke(IpcChannel.App_RelaunchApp, options),
  resetData: () => ipcRenderer.invoke(IpcChannel.App_ResetData),
  openWebsite: (url: string) => ipcRenderer.invoke(IpcChannel.Open_Website, url),
  getCacheSize: () => ipcRenderer.invoke(IpcChannel.App_GetCacheSize),
  clearCache: () => ipcRenderer.invoke(IpcChannel.App_ClearCache),
  logToMain: (source: LogSourceWithContext, level: LogLevel, message: string, data: any[]) =>
    ipcRenderer.invoke(IpcChannel.App_LogToMain, source, level, message, data),
  setFullScreen: (value: boolean): Promise<void> => ipcRenderer.invoke(IpcChannel.App_SetFullScreen, value),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.App_IsFullScreen),
  getSystemFonts: (): Promise<string[]> => ipcRenderer.invoke(IpcChannel.App_GetSystemFonts),
  getIpCountry: (): Promise<string> => ipcRenderer.invoke(IpcChannel.App_GetIpCountry),
  mockCrashRenderProcess: () => ipcRenderer.invoke(IpcChannel.APP_CrashRenderProcess),
  notification: {
    send: (notification: Notification) => ipcRenderer.invoke(IpcChannel.Notification_Send, notification)
  },
  system: {
    getDeviceType: () => ipcRenderer.invoke(IpcChannel.System_GetDeviceType),
    getHostname: () => ipcRenderer.invoke(IpcChannel.System_GetHostname)
  },
  devTools: {
    toggle: () => ipcRenderer.invoke(IpcChannel.System_ToggleDevTools)
  },
  zip: {
    decompress: (text: Buffer) => ipcRenderer.invoke(IpcChannel.Zip_Decompress, text)
  },
  backup: {
    restore: (path: string) => ipcRenderer.invoke(IpcChannel.Backup_Restore, path),
    // Direct backup methods (copy IndexedDB/LocalStorage directories directly)
    backup: (fileName: string, destinationPath: string, skipBackupFile: boolean) =>
      ipcRenderer.invoke(IpcChannel.Backup_Backup, fileName, destinationPath, skipBackupFile),
    backupToWebdav: (webdavConfig: WebDavConfig) => ipcRenderer.invoke(IpcChannel.Backup_BackupToWebdav, webdavConfig),
    restoreFromWebdav: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_RestoreFromWebdav, webdavConfig),
    listWebdavFiles: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_ListWebdavFiles, webdavConfig),
    checkConnection: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_CheckConnection, webdavConfig),
    createDirectory: (webdavConfig: WebDavConfig, path: string, options?: CreateDirectoryOptions) =>
      ipcRenderer.invoke(IpcChannel.Backup_CreateDirectory, webdavConfig, path, options),
    deleteWebdavFile: (fileName: string, webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteWebdavFile, fileName, webdavConfig),
    backupToLocalDir: (fileName: string, localConfig: { localBackupDir?: string; skipBackupFile?: boolean }) =>
      ipcRenderer.invoke(IpcChannel.Backup_BackupToLocalDir, fileName, localConfig),
    restoreFromLocalBackup: (fileName: string, localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_RestoreFromLocalBackup, fileName, localBackupDir),
    listLocalBackupFiles: (localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_ListLocalBackupFiles, localBackupDir),
    deleteLocalBackupFile: (fileName: string, localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteLocalBackupFile, fileName, localBackupDir),
    checkWebdavConnection: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_CheckConnection, webdavConfig)
  },
  file: {
    select: (options?: OpenDialogOptions): Promise<FileMetadata[] | null> =>
      ipcRenderer.invoke(IpcChannel.File_Select, options),
    upload: (file: FileMetadata) => ipcRenderer.invoke(IpcChannel.File_Upload, file),
    delete: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_Delete, fileId),
    deleteDir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteDir, dirPath),
    deleteExternalFile: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteExternalFile, filePath),
    deleteExternalDir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteExternalDir, dirPath),
    move: (path: string, newPath: string) => ipcRenderer.invoke(IpcChannel.File_Move, path, newPath),
    moveDir: (dirPath: string, newDirPath: string) => ipcRenderer.invoke(IpcChannel.File_MoveDir, dirPath, newDirPath),
    rename: (path: string, newName: string) => ipcRenderer.invoke(IpcChannel.File_Rename, path, newName),
    renameDir: (dirPath: string, newName: string) => ipcRenderer.invoke(IpcChannel.File_RenameDir, dirPath, newName),
    read: (fileId: string, detectEncoding?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_Read, fileId, detectEncoding),
    readExternal: (filePath: string, detectEncoding?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_ReadExternal, filePath, detectEncoding),
    clear: (spanContext?: SpanContext) => ipcRenderer.invoke(IpcChannel.File_Clear, spanContext),
    get: (filePath: string): Promise<FileMetadata | null> => ipcRenderer.invoke(IpcChannel.File_Get, filePath),
    createTempFile: (fileName: string): Promise<string> => ipcRenderer.invoke(IpcChannel.File_CreateTempFile, fileName),
    mkdir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_Mkdir, dirPath),
    write: (filePath: string, data: Uint8Array | string) => ipcRenderer.invoke(IpcChannel.File_Write, filePath, data),
    writeWithId: (id: string, content: string) => ipcRenderer.invoke(IpcChannel.File_WriteWithId, id, content),
    // v0.3.3-2：生成图内容寻址落盘（id = 源串 sha256；同 id 同文件，回放不堆积）
    saveGeneratedImage: (payload: { id: string; source: string }): Promise<unknown> =>
      ipcRenderer.invoke(IpcChannel.File_SaveGeneratedImage, payload),
    open: (options?: OpenDialogOptions) => ipcRenderer.invoke(IpcChannel.File_Open, options),
    openPath: (path: string) => ipcRenderer.invoke(IpcChannel.File_OpenPath, path),
    save: (path: string, content: string | NodeJS.ArrayBufferView, options?: any) =>
      ipcRenderer.invoke(IpcChannel.File_Save, path, content, options),
    selectFolder: (options?: OpenDialogOptions): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.File_SelectFolder, options),
    saveImage: (name: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.File_SaveImage, name, data),
    binaryImage: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_BinaryImage, fileId),
    base64Image: (fileId: string): Promise<{ mime: string; base64: string; data: string }> =>
      ipcRenderer.invoke(IpcChannel.File_Base64Image, fileId),
    saveBase64Image: (data: string) => ipcRenderer.invoke(IpcChannel.File_SaveBase64Image, data),
    savePastedImage: (imageData: Uint8Array, extension?: string) =>
      ipcRenderer.invoke(IpcChannel.File_SavePastedImage, imageData, extension),
    download: (url: string, isUseContentType?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_Download, url, isUseContentType),
    copy: (fileId: string, destPath: string) => ipcRenderer.invoke(IpcChannel.File_Copy, fileId, destPath),
    base64File: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_Base64File, fileId),
    pdfInfo: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_GetPdfInfo, fileId),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    openFileWithRelativePath: (file: FileMetadata) => ipcRenderer.invoke(IpcChannel.File_OpenWithRelativePath, file),
    isTextFile: (filePath: string): Promise<boolean> => ipcRenderer.invoke(IpcChannel.File_IsTextFile, filePath),
    isDirectory: (filePath: string): Promise<boolean> => ipcRenderer.invoke(IpcChannel.File_IsDirectory, filePath),
    getDirectoryStructure: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_GetDirectoryStructure, dirPath),
    // v0.3.3-2 笔记（V1 原样）：用户自选笔记目录的校验/补全
    validateNotesDirectory: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_ValidateNotesDirectory, dirPath),
    listDirectory: (dirPath: string, options?: DirectoryListOptions) =>
      ipcRenderer.invoke(IpcChannel.File_ListDirectory, dirPath, options),
    checkFileName: (dirPath: string, fileName: string, isFile: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_CheckFileName, dirPath, fileName, isFile),
    startFileWatcher: (dirPath: string, config?: any) =>
      ipcRenderer.invoke(IpcChannel.File_StartWatcher, dirPath, config),
    stopFileWatcher: () => ipcRenderer.invoke(IpcChannel.File_StopWatcher),
    pauseFileWatcher: () => ipcRenderer.invoke(IpcChannel.File_PauseWatcher),
    resumeFileWatcher: () => ipcRenderer.invoke(IpcChannel.File_ResumeWatcher),
    batchUploadMarkdown: (filePaths: string[], targetPath: string) =>
      ipcRenderer.invoke(IpcChannel.File_BatchUploadMarkdown, filePaths, targetPath),
    onFileChange: (callback: (data: FileChangeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: any) => {
        if (data && typeof data === 'object') {
          callback(data)
        }
      }
      ipcRenderer.on('file-change', listener)
      return () => ipcRenderer.off('file-change', listener)
    },
    showInFolder: (path: string): Promise<void> => ipcRenderer.invoke(IpcChannel.File_ShowInFolder, path)
  },
  fs: {
    read: (pathOrUrl: string, encoding?: BufferEncoding) => ipcRenderer.invoke(IpcChannel.Fs_Read, pathOrUrl, encoding),
    readText: (pathOrUrl: string): Promise<string> => ipcRenderer.invoke(IpcChannel.Fs_ReadText, pathOrUrl)
  },
  pdf: {
    extractText: (data: Uint8Array | ArrayBuffer | string): Promise<string> =>
      ipcRenderer.invoke(IpcChannel.Pdf_ExtractText, data)
  },
  export: {
    toWord: (markdown: string, fileName: string) => ipcRenderer.invoke(IpcChannel.Export_Word, markdown, fileName)
  },
  openPath: (path: string) => ipcRenderer.invoke(IpcChannel.Open_Path, path),
  shortcuts: {
    update: (shortcuts: Shortcut[]) => ipcRenderer.invoke(IpcChannel.Shortcuts_Update, shortcuts)
  },
  memory: {
    add: (messages: string | AssistantMessage[], options?: AddMemoryOptions) =>
      ipcRenderer.invoke(IpcChannel.Memory_Add, messages, options),
    search: (query: string, options: MemorySearchOptions) =>
      ipcRenderer.invoke(IpcChannel.Memory_Search, query, options),
    list: (options?: MemoryListOptions) => ipcRenderer.invoke(IpcChannel.Memory_List, options),
    delete: (id: string) => ipcRenderer.invoke(IpcChannel.Memory_Delete, id),
    update: (id: string, memory: string, metadata?: Record<string, any>) =>
      ipcRenderer.invoke(IpcChannel.Memory_Update, id, memory, metadata),
    get: (id: string) => ipcRenderer.invoke(IpcChannel.Memory_Get, id),
    setConfig: (config: MemoryConfig) => ipcRenderer.invoke(IpcChannel.Memory_SetConfig, config),
    deleteUser: (userId: string) => ipcRenderer.invoke(IpcChannel.Memory_DeleteUser, userId),
    deleteAllMemoriesForUser: (userId: string) =>
      ipcRenderer.invoke(IpcChannel.Memory_DeleteAllMemoriesForUser, userId),
    getUsersList: () => ipcRenderer.invoke(IpcChannel.Memory_GetUsersList),
    migrateMemoryDb: () => ipcRenderer.invoke(IpcChannel.Memory_MigrateMemoryDb)
  },
  window: {
    setMinimumSize: (width: number, height: number) =>
      ipcRenderer.invoke(IpcChannel.Windows_SetMinimumSize, width, height),
    resetMinimumSize: () => ipcRenderer.invoke(IpcChannel.Windows_ResetMinimumSize),
    getSize: (): Promise<[number, number]> => ipcRenderer.invoke(IpcChannel.Windows_GetSize)
  },
  config: {
    set: (key: string, value: any, isNotify: boolean = false) =>
      ipcRenderer.invoke(IpcChannel.Config_Set, key, value, isNotify)
  },
  miniWindow: {
    hide: () => ipcRenderer.invoke(IpcChannel.MiniWindow_Hide),
    close: () => ipcRenderer.invoke(IpcChannel.MiniWindow_Close),
    setPin: (isPinned: boolean) => ipcRenderer.invoke(IpcChannel.MiniWindow_SetPin, isPinned)
  },
  aes: {
    decrypt: (encryptedData: string, iv: string, secretKey: string) =>
      ipcRenderer.invoke(IpcChannel.Aes_Decrypt, encryptedData, iv, secretKey)
  },
  providerKeys: {
    getAll: () => ipcRenderer.invoke(IpcChannel.ProviderKeys_GetAll),
    set: (providerId: string, apiKey: string) => ipcRenderer.invoke(IpcChannel.ProviderKeys_Set, providerId, apiKey),
    remove: (providerId: string) => ipcRenderer.invoke(IpcChannel.ProviderKeys_Remove, providerId)
  },
  shell: {
    openExternal: (url: string, options?: Electron.OpenExternalOptions) => {
      // Defense-in-depth: validate URL scheme before forwarding to shell.openExternal
      const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'obsidian:']
      try {
        const parsed = new URL(url)
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
          return Promise.reject(new Error(`Blocked openExternal for untrusted URL scheme: ${parsed.protocol}`))
        }
      } catch {
        return Promise.reject(new Error('Blocked openExternal for invalid URL'))
      }
      return shell.openExternal(url, options)
    }
  },
  protocol: {
    onReceiveData: (callback: (data: { url: string; params: any }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { url: string; params: any }) => {
        callback(data)
      }
      ipcRenderer.on('protocol-data', listener)
      return () => {
        ipcRenderer.off('protocol-data', listener)
      }
    }
  },
  externalApps: {
    detectInstalled: (): Promise<ExternalAppInfo[]> => ipcRenderer.invoke(IpcChannel.ExternalApps_DetectInstalled)
  },
  nutstore: {
    getSSOUrl: () => ipcRenderer.invoke(IpcChannel.Nutstore_GetSsoUrl),
    decryptToken: (token: string) => ipcRenderer.invoke(IpcChannel.Nutstore_DecryptToken, token),
    getDirectoryContents: (token: string, path: string) =>
      ipcRenderer.invoke(IpcChannel.Nutstore_GetDirectoryContents, token, path)
  },
  searchService: {
    openUrlInSearchWindow: (uid: string, url: string) => ipcRenderer.invoke(IpcChannel.SearchWindow_OpenUrl, uid, url),
    closeSearchWindow: (uid: string) => ipcRenderer.invoke(IpcChannel.SearchWindow_Close, uid)
  },
  webview: {
    setOpenLinkExternal: (webviewId: number, isExternal: boolean) =>
      ipcRenderer.invoke(IpcChannel.Webview_SetOpenLinkExternal, webviewId, isExternal),
    setSpellCheckEnabled: (webviewId: number, isEnable: boolean) =>
      ipcRenderer.invoke(IpcChannel.Webview_SetSpellCheckEnabled, webviewId, isEnable),
    printToPDF: (webviewId: number) => ipcRenderer.invoke(IpcChannel.Webview_PrintToPDF, webviewId),
    saveAsHTML: (webviewId: number) => ipcRenderer.invoke(IpcChannel.Webview_SaveAsHTML, webviewId),
    onFindShortcut: (callback: (payload: WebviewKeyEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WebviewKeyEvent) => {
        callback(payload)
      }
      ipcRenderer.on(IpcChannel.Webview_SearchHotkey, listener)
      return () => {
        ipcRenderer.off(IpcChannel.Webview_SearchHotkey, listener)
      }
    }
  },
  storeSync: {
    subscribe: () => ipcRenderer.invoke(IpcChannel.StoreSync_Subscribe),
    unsubscribe: () => ipcRenderer.invoke(IpcChannel.StoreSync_Unsubscribe),
    onUpdate: (action: any) => ipcRenderer.invoke(IpcChannel.StoreSync_OnUpdate, action)
  },
  quoteToMainWindow: (text: string) => ipcRenderer.invoke(IpcChannel.App_QuoteToMain, text),
  setDisableHardwareAcceleration: (isDisable: boolean) =>
    ipcRenderer.invoke(IpcChannel.App_SetDisableHardwareAcceleration, isDisable),
  setUseSystemTitleBar: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetUseSystemTitleBar, isActive),
  trace: {
    saveData: (topicId: string) => ipcRenderer.invoke(IpcChannel.TRACE_SAVE_DATA, topicId),
    getData: (topicId: string, traceId: string, modelName?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_GET_DATA, topicId, traceId, modelName),
    saveEntity: (entity: SpanEntity) => ipcRenderer.invoke(IpcChannel.TRACE_SAVE_ENTITY, entity),
    bindTopic: (topicId: string, traceId: string) => ipcRenderer.invoke(IpcChannel.TRACE_BIND_TOPIC, topicId, traceId),
    tokenUsage: (spanId: string, usage: TokenUsage) => ipcRenderer.invoke(IpcChannel.TRACE_TOKEN_USAGE, spanId, usage),
    cleanHistory: (topicId: string, traceId: string, modelName?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_HISTORY, topicId, traceId, modelName),
    cleanTopic: (topicId: string, traceId?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_TOPIC, topicId, traceId),
    openWindow: (topicId: string, traceId: string, autoOpen?: boolean, modelName?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_OPEN_WINDOW, topicId, traceId, autoOpen, modelName),
    setTraceWindowTitle: (title: string) => ipcRenderer.invoke(IpcChannel.TRACE_SET_TITLE, title),
    addEndMessage: (spanId: string, modelName: string, context: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_ADD_END_MESSAGE, spanId, modelName, context),
    cleanLocalData: () => ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_LOCAL_DATA),
    addStreamMessage: (spanId: string, modelName: string, context: string, message: any) =>
      ipcRenderer.invoke(IpcChannel.TRACE_ADD_STREAM_MESSAGE, spanId, modelName, context, message)
  },
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Minimize),
    maximize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Maximize),
    unmaximize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Unmaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Close),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.Windows_IsMaximized),
    onMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
      const channel = IpcChannel.Windows_MaximizedChanged
      const listener = (_: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    }
  },
  analytics: {
    trackTokenUsage: (data: TokenUsageData) => ipcRenderer.invoke(IpcChannel.Analytics_TrackTokenUsage, data)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[Preload]Failed to expose APIs:', error as Error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}

export type WindowApiType = typeof api
