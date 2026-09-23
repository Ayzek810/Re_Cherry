export enum IpcChannel {
  App_GetCacheSize = 'app:get-cache-size',
  App_ClearCache = 'app:clear-cache',
  App_SetLaunchOnBoot = 'app:set-launch-on-boot',
  App_SetLanguage = 'app:set-language',
  App_SetEnableSpellCheck = 'app:set-enable-spell-check',
  App_SetSpellCheckLanguages = 'app:set-spell-check-languages',
  App_Reload = 'app:reload',
  App_Quit = 'app:quit',
  App_Info = 'app:info',
  App_Proxy = 'app:proxy',
  App_SetLaunchToTray = 'app:set-launch-to-tray',
  App_SetTray = 'app:set-tray',
  App_SetTrayOnClose = 'app:set-tray-on-close',
  App_SetTheme = 'app:set-theme',
  App_HandleZoomFactor = 'app:handle-zoom-factor',
  App_Select = 'app:select',
  App_HasWritePermission = 'app:has-write-permission',
  App_ResolvePath = 'app:resolve-path',
  App_IsPathInside = 'app:is-path-inside',
  App_Copy = 'app:copy',
  App_SetStopQuitApp = 'app:set-stop-quit-app',
  App_SetAppDataPath = 'app:set-app-data-path',
  App_GetDataPathFromArgs = 'app:get-data-path-from-args',
  App_FlushAppData = 'app:flush-app-data',
  App_IsNotEmptyDir = 'app:is-not-empty-dir',
  App_RelaunchApp = 'app:relaunch-app',
  App_ResetData = 'app:reset-data',
  App_LogToMain = 'app:log-to-main',
  App_SaveData = 'app:save-data',
  App_GetDiskInfo = 'app:get-disk-info',
  App_SetFullScreen = 'app:set-full-screen',
  App_IsFullScreen = 'app:is-full-screen',
  App_GetSystemFonts = 'app:get-system-fonts',
  App_GetIpCountry = 'app:get-ip-country',
  APP_CrashRenderProcess = 'app:crash-render-process',

  App_QuoteToMain = 'app:quote-to-main',
  App_SetDisableHardwareAcceleration = 'app:set-disable-hardware-acceleration',
  App_SetUseSystemTitleBar = 'app:set-use-system-title-bar',

  Notification_Send = 'notification:send',

  Webview_SetOpenLinkExternal = 'webview:set-open-link-external',
  Webview_SetSpellCheckEnabled = 'webview:set-spell-check-enabled',
  Webview_SearchHotkey = 'webview:search-hotkey',
  Webview_PrintToPDF = 'webview:print-to-pdf',
  Webview_SaveAsHTML = 'webview:save-as-html',

  // Open
  Open_Path = 'open:path',
  Open_Website = 'open:website',

  Config_Set = 'config:set',

  MiniWindow_Hide = 'miniwindow:hide',
  MiniWindow_Close = 'miniwindow:close',
  MiniWindow_SetPin = 'miniwindow:set-pin',

  // nutstore
  Nutstore_GetSsoUrl = 'nutstore:get-sso-url',
  Nutstore_DecryptToken = 'nutstore:decrypt-token',
  Nutstore_GetDirectoryContents = 'nutstore:get-directory-contents',

  //aes
  Aes_Decrypt = 'aes:decrypt',

  Windows_ResetMinimumSize = 'window:reset-minimum-size',
  Windows_SetMinimumSize = 'window:set-minimum-size',
  Windows_Resize = 'window:resize',
  Windows_GetSize = 'window:get-size',
  Windows_Minimize = 'window:minimize',
  Windows_Maximize = 'window:maximize',
  Windows_Unmaximize = 'window:unmaximize',
  Windows_Close = 'window:close',
  Windows_IsMaximized = 'window:is-maximized',
  Windows_MaximizedChanged = 'window:maximized-changed',
  Windows_NavigateToAbout = 'window:navigate-to-about',

  //file
  File_Open = 'file:open',
  File_OpenPath = 'file:openPath',
  File_Save = 'file:save',
  File_Select = 'file:select',
  File_Upload = 'file:upload',
  File_Clear = 'file:clear',
  File_Read = 'file:read',
  File_ReadExternal = 'file:readExternal',
  File_Delete = 'file:delete',
  File_DeleteDir = 'file:deleteDir',
  File_DeleteExternalFile = 'file:deleteExternalFile',
  File_DeleteExternalDir = 'file:deleteExternalDir',
  File_Move = 'file:move',
  File_MoveDir = 'file:moveDir',
  File_Rename = 'file:rename',
  File_RenameDir = 'file:renameDir',
  File_Get = 'file:get',
  File_SelectFolder = 'file:selectFolder',
  File_CreateTempFile = 'file:createTempFile',
  File_Mkdir = 'file:mkdir',
  File_Write = 'file:write',
  File_WriteWithId = 'file:writeWithId',
  File_SaveImage = 'file:saveImage',
  File_Base64Image = 'file:base64Image',
  File_SaveBase64Image = 'file:saveBase64Image',
  File_SavePastedImage = 'file:savePastedImage',
  File_Download = 'file:download',
  File_Copy = 'file:copy',
  File_BinaryImage = 'file:binaryImage',
  File_Base64File = 'file:base64File',
  File_GetPdfInfo = 'file:getPdfInfo',
  Fs_Read = 'fs:read',
  Fs_ReadText = 'fs:readText',
  File_OpenWithRelativePath = 'file:openWithRelativePath',
  File_IsTextFile = 'file:isTextFile',
  File_IsDirectory = 'file:isDirectory',
  File_ListDirectory = 'file:listDirectory',
  File_GetDirectoryStructure = 'file:getDirectoryStructure',
  File_CheckFileName = 'file:checkFileName',
  File_StartWatcher = 'file:startWatcher',
  File_StopWatcher = 'file:stopWatcher',
  File_PauseWatcher = 'file:pauseWatcher',
  File_ResumeWatcher = 'file:resumeWatcher',
  File_BatchUploadMarkdown = 'file:batchUploadMarkdown',
  File_ShowInFolder = 'file:showInFolder',

  // PDF
  Pdf_ExtractText = 'pdf:extractText',

  Export_Word = 'export:word',

  Shortcuts_Update = 'shortcuts:update',

  // backup
  Backup_Backup = 'backup:backup',
  Backup_Restore = 'backup:restore',
  Backup_BackupToWebdav = 'backup:backupToWebdav',
  Backup_RestoreFromWebdav = 'backup:restoreFromWebdav',
  Backup_ListWebdavFiles = 'backup:listWebdavFiles',
  Backup_CheckConnection = 'backup:checkConnection',
  Backup_CreateDirectory = 'backup:createDirectory',
  Backup_DeleteWebdavFile = 'backup:deleteWebdavFile',
  Backup_BackupToLocalDir = 'backup:backupToLocalDir',
  Backup_RestoreFromLocalBackup = 'backup:restoreFromLocalBackup',
  Backup_ListLocalBackupFiles = 'backup:listLocalBackupFiles',
  Backup_DeleteLocalBackupFile = 'backup:deleteLocalBackupFile',

  // zip
  Zip_Decompress = 'zip:decompress',

  // system
  System_GetDeviceType = 'system:getDeviceType',
  System_GetHostname = 'system:getHostname',

  // DevTools
  System_ToggleDevTools = 'system:toggleDevTools',

  // events
  BackupProgress = 'backup-progress',
  ThemeUpdated = 'theme:updated',
  RestoreProgress = 'restore-progress',

  FullscreenStatusChanged = 'fullscreen-status-changed',

  ShowMiniWindow = 'show-mini-window',

  // Search Window
  SearchWindow_OpenUrl = 'search-window:open-url',
  SearchWindow_Close = 'search-window:close',

  //Store Sync
  StoreSync_Subscribe = 'store-sync:subscribe',
  StoreSync_Unsubscribe = 'store-sync:unsubscribe',
  StoreSync_OnUpdate = 'store-sync:on-update',
  StoreSync_BroadcastSync = 'store-sync:broadcast-sync',

  // Memory
  Memory_Add = 'memory:add',
  Memory_Search = 'memory:search',
  Memory_List = 'memory:list',
  Memory_Delete = 'memory:delete',
  Memory_Update = 'memory:update',
  Memory_Get = 'memory:get',
  Memory_SetConfig = 'memory:set-config',
  Memory_DeleteUser = 'memory:delete-user',
  Memory_DeleteAllMemoriesForUser = 'memory:delete-all-memories-for-user',
  Memory_GetUsersList = 'memory:get-users-list',
  Memory_MigrateMemoryDb = 'memory:migrate-memory-db',

  // TRACE
  TRACE_SAVE_DATA = 'trace:saveData',
  TRACE_GET_DATA = 'trace:getData',
  TRACE_SAVE_ENTITY = 'trace:saveEntity',
  TRACE_BIND_TOPIC = 'trace:bindTopic',
  TRACE_CLEAN_TOPIC = 'trace:cleanTopic',
  TRACE_TOKEN_USAGE = 'trace:tokenUsage',
  TRACE_CLEAN_HISTORY = 'trace:cleanHistory',
  TRACE_OPEN_WINDOW = 'trace:openWindow',
  TRACE_SET_TITLE = 'trace:setTitle',
  TRACE_ADD_END_MESSAGE = 'trace:addEndMessage',
  TRACE_CLEAN_LOCAL_DATA = 'trace:cleanLocalData',
  TRACE_ADD_STREAM_MESSAGE = 'trace:addStreamMessage',

  // ExternalApps
  ExternalApps_DetectInstalled = 'external-apps:detect-installed',

  // Analytics
  Analytics_TrackTokenUsage = 'analytics:track-token-usage',

  // provider key 加密存储（v0.2.4 K 线）
  ProviderKeys_GetAll = 'provider-keys:get-all',
  ProviderKeys_Set = 'provider-keys:set',
  ProviderKeys_Remove = 'provider-keys:remove',

  // dsh kernel
  Dsh_SyncProviders = 'dsh:sync-providers',
  Dsh_SyncImageDescriber = 'dsh:sync-image-describer',
  /** 网络搜索配置同步（批次2）：渲染层 websearch 切片 → 主进程 WebSearchService。 */
  Dsh_SyncWebSearch = 'dsh:sync-web-search',
  /** MCP 服务器配置同步（批次3）：渲染层 mcp 切片 → 主进程 MCPService（内存投影）。 */
  Dsh_SyncMcpServers = 'dsh:sync-mcp-servers',
  /**
   * 文档处理通道配置同步（§7.17 三轮）：渲染层 preprocess 切片 providers（含 apiKey，
   * 只进主进程内存）→ preprocessChannel 配置表；ocr_document 工具与知识库摄取按此路由。
   */
  Dsh_SyncPreprocess = 'dsh:sync-preprocess',
  /** MCP 设置页通道（批次3）：服务器生命周期与发现（上游 Mcp_* 命名子集）。 */
  Mcp_ListTools = 'mcp:list-tools',
  Mcp_ListPrompts = 'mcp:list-prompts',
  Mcp_ListResources = 'mcp:list-resources',
  Mcp_GetServerVersion = 'mcp:get-server-version',
  Mcp_GetServerLogs = 'mcp:get-server-logs',
  Mcp_RestartServer = 'mcp:restart-server',
  Mcp_StopServer = 'mcp:stop-server',
  Mcp_RemoveServer = 'mcp:remove-server',
  Mcp_CheckConnectivity = 'mcp:check-connectivity',
  /** MCP 服务器日志事件（主 → 渲染，上游 Mcp_ServerLog 同语义）。 */
  Mcp_ServerLog = 'mcp:server-log',
  /** 知识库通道（批次4）：库文件生命周期 + 条目处理 + 检索（上游 KnowledgeBase_* 命名子集）。 */
  KnowledgeBase_Create = 'knowledge-base:create',
  KnowledgeBase_Reset = 'knowledge-base:reset',
  KnowledgeBase_Delete = 'knowledge-base:delete',
  KnowledgeBase_Add = 'knowledge-base:add',
  KnowledgeBase_Remove = 'knowledge-base:remove',
  KnowledgeBase_Search = 'knowledge-base:search',
  /** 本地模型（v0.3.2 自 CS_V2 移植）：OCR 权重下载生命周期（进度渲染层轮询 getStatus）。 */
  LocalModel_GetStatus = 'local-model:get-status',
  LocalModel_Download = 'local-model:download',
  LocalModel_Cancel = 'local-model:cancel',
  LocalModel_Remove = 'local-model:remove',
  /** 技能通道（批次5）：zip/目录/URL 安装 + 卸载真删盘 + 库扫描（上游 Skill_* 命名子集）。 */
  Skill_InstallFromZip = 'skill:install-from-zip',
  Skill_InstallFromDirectory = 'skill:install-from-directory',
  Skill_InstallFromUrl = 'skill:install-from-url',
  Skill_Uninstall = 'skill:uninstall',
  Skill_List = 'skill:list',
  /** 网络搜索连通性检查（批次2）：'test query' 真跑一次（设置页「检查」按钮）。 */
  WebSearch_Check = 'web-search:check',
  Dsh_StreamSmoke = 'dsh:stream-smoke',
  Dsh_Complete = 'dsh:complete',
  Dsh_StreamComplete = 'dsh:stream-complete',
  // fork 缝：轻量流式补全的真取消通道（无载荷校验：requestId 配对，未命中即无害空操作）。
  Dsh_StreamAbort = 'dsh:stream-abort',
  Dsh_CompletionEvent = 'dsh:completion-event',
  Dsh_TopicList = 'dsh:topic-list',
  Dsh_TopicCreate = 'dsh:topic-create',
  Dsh_TopicRename = 'dsh:topic-rename',
  Dsh_TopicDelete = 'dsh:topic-delete',
  Dsh_TopicDestroyTurns = 'dsh:topic-destroy-turns',
  Dsh_TopicOpen = 'dsh:topic-open',
  Dsh_TopicFork = 'dsh:topic-fork',
  Dsh_TopicBranches = 'dsh:topic-branches',
  Dsh_TopicSend = 'dsh:topic-send',
  Dsh_TopicStop = 'dsh:topic-stop',
  Dsh_TopicRunning = 'dsh:topic-running',
  Dsh_TopicEvents = 'dsh:topic-events',
  Dsh_TopicGet = 'dsh:topic-get',
  Dsh_ApprovalRequest = 'dsh:approval-request',
  Dsh_ApprovalDecide = 'dsh:approval-decide',
  Dsh_QuestionRequest = 'dsh:question-request',
  Dsh_QuestionAnswer = 'dsh:question-answer',
  Dsh_SearchMessages = 'dsh:search-messages',
  Dsh_SessionEvent = 'dsh:session-event',
  /** 内核图片附件 → 渲染层文件仓的回放同步（v0.3.1 识图通道；读 ref、写字节、返回 FileMetadata）。 */
  Dsh_AttachmentSync = 'dsh:attachment-sync',
  /** 轻量图像模态（绘画页/生图工具的执行缝；OpenAI 兼容平面直连，实现 kernel/lightLlmModalities）。 */
  Dsh_LightImage = 'dsh:light-image',
  Dsh_LightImageAbort = 'dsh:light-image-abort'
}
