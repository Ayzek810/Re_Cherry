import { loggerService } from '@logger'
import PrivacyPolicyUpdateNotice from '@renderer/components/app/PrivacyPolicyUpdateNotice'
import { isMac, LATEST_PRIVACY_POLICY_VERSION } from '@renderer/config/constant'
import { isLocalAi } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import db from '@renderer/databases'
import i18n, { setDayjsLocale } from '@renderer/i18n'
import {
  initKernelBridge,
  syncImageDescriberToKernel,
  syncPreprocessToKernel,
  syncProvidersToKernel,
  syncWebSearchToKernel
} from '@renderer/services/kernelChat'
import MemoryService from '@renderer/services/MemoryService'
import { handleSaveData, useAppDispatch, useAppSelector } from '@renderer/store'
import { selectMemoryConfig } from '@renderer/store/memory'
import { setAvatar, setFilesPath, setResourcesPath } from '@renderer/store/runtime'
import { checkDataLimit } from '@renderer/utils'
import { defaultLanguage } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'

import { useDefaultModel } from './useAssistant'
import useFullScreenNotice from './useFullScreenNotice'
import { useRuntime } from './useRuntime'
import { useNavbarPosition, useSettings } from './useSettings'

const logger = loggerService.withContext('useAppInit')

export function useAppInit() {
  const dispatch = useAppDispatch()
  const {
    proxyUrl,
    proxyBypassRules,
    language,
    windowStyle,
    proxyMode,
    customCss,
    enableDataCollection,
    privacyPolicyVersion
  } = useSettings()
  const { isLeftNavbar } = useNavbarPosition()
  const { minappShow } = useRuntime()
  const { setDefaultModel, setQuickModel } = useDefaultModel()
  const avatar = useLiveQuery(() => db.settings.get('image://avatar'))
  const { theme } = useTheme()
  const memoryConfig = useAppSelector(selectMemoryConfig)

  useEffect(() => {
    document.getElementById('spinner')?.remove()
    // eslint-disable-next-line no-restricted-syntax
    console.timeEnd('init')

    // Initialize MemoryService after app is ready
    MemoryService.getInstance()
  }, [])

  useEffect(() => {
    void window.api.getDataPathFromArgs().then((dataPath) => {
      if (dataPath) {
        window.navigate('/settings/data', { replace: true })
      }
    })
  }, [])

  useEffect(() => {
    window.electron.ipcRenderer.on(IpcChannel.App_SaveData, async () => {
      await handleSaveData()
    })
  }, [])

  useFullScreenNotice()

  useEffect(() => {
    if (privacyPolicyVersion === LATEST_PRIVACY_POLICY_VERSION) {
      PrivacyPolicyUpdateNotice.hide()
      return
    }

    void PrivacyPolicyUpdateNotice.show()
  }, [privacyPolicyVersion])

  useEffect(() => {
    avatar?.value && dispatch(setAvatar(avatar.value))
  }, [avatar, dispatch])

  useEffect(() => {
    if (proxyMode === 'system') {
      void window.api.setProxy('system', undefined)
    } else if (proxyMode === 'custom') {
      void (proxyUrl && window.api.setProxy(proxyUrl, proxyBypassRules))
    } else {
      // set proxy to none for direct mode
      void window.api.setProxy('', undefined)
    }
  }, [proxyUrl, proxyMode, proxyBypassRules])

  useEffect(() => {
    const currentLanguage = language || navigator.language || defaultLanguage
    void i18n.changeLanguage(currentLanguage)
    setDayjsLocale(currentLanguage)
  }, [language])

  useEffect(() => {
    const isMacTransparentWindow = windowStyle === 'transparent' && isMac

    if (minappShow && isLeftNavbar) {
      window.root.style.background = isMacTransparentWindow ? 'var(--color-background)' : 'var(--navbar-background)'
      return
    }

    window.root.style.background = isMacTransparentWindow ? 'var(--navbar-background-mac)' : 'var(--navbar-background)'
  }, [windowStyle, minappShow, theme, isLeftNavbar])

  useEffect(() => {
    if (isLocalAi) {
      const model = JSON.parse(import.meta.env.VITE_RENDERER_INTEGRATED_MODEL)
      setDefaultModel(model)
      setQuickModel(model)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // set files path
    void window.api.getAppInfo().then((info) => {
      dispatch(setFilesPath(info.filesPath))
      dispatch(setResourcesPath(info.resourcesPath))
    })
  }, [dispatch])

  useEffect(() => {
    let customCssElement = document.getElementById('user-defined-custom-css') as HTMLStyleElement
    if (customCssElement) {
      customCssElement.remove()
    }

    if (customCss) {
      customCssElement = document.createElement('style')
      customCssElement.id = 'user-defined-custom-css'
      customCssElement.textContent = customCss
      document.head.appendChild(customCssElement)
    }
  }, [customCss])

  useEffect(() => {
    void window.api.config.set('enableDataCollection', enableDataCollection)
  }, [enableDataCollection])

  // Update memory service configuration when it changes
  useEffect(() => {
    const memoryService = MemoryService.getInstance()
    memoryService.updateConfig().catch((error) => logger.error('Failed to update memory config:', error))
  }, [memoryConfig])

  useEffect(() => {
    // dsh 内核桥：订阅内核 session 事件流
    initKernelBridge()
  }, [])

  const kernelProviders = useAppSelector((state) => state.llm.providers)
  const imageDescriberModel = useAppSelector((state) => state.llm.imageDescriberModel)
  const imageDescriberPrompt = useAppSelector((state) => state.llm.imageDescriberPrompt)
  // 批次2 网络搜索：websearch 切片（providers/blacklist/searchWithTime）变更即推内核
  const webSearchState = useAppSelector((state) => state.websearch)

  useEffect(() => {
    void syncWebSearchToKernel({
      providers: (webSearchState.providers ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        apiKey: p.apiKey,
        apiHost: p.apiHost,
        url: p.url,
        engines: p.engines,
        basicAuthUsername: p.basicAuthUsername,
        basicAuthPassword: p.basicAuthPassword,
        usingBrowser: p.usingBrowser
      })),
      // 订阅源黑名单（ublacklist 模式）平铺合并；excludeDomains 单独透传
      blacklist: (webSearchState.subscribeSources ?? []).flatMap((s) => s.blacklist ?? []),
      excludeDomains: webSearchState.excludeDomains ?? [],
      searchWithTime: webSearchState.searchWithTime ?? false,
      maxResults: webSearchState.maxResults ?? 5,
      // 结果压缩投影（批次7）：embeddingModel(Model) 收窄为 {providerId, modelId} 引用，
      // 密钥由主进程自解析（同知识库先例），不在此通道传 apiKey。
      compression: webSearchState.compressionConfig
        ? {
            method: webSearchState.compressionConfig.method ?? 'none',
            cutoffLimit: webSearchState.compressionConfig.cutoffLimit,
            cutoffUnit: webSearchState.compressionConfig.cutoffUnit,
            documentCount: webSearchState.compressionConfig.documentCount,
            embedding: webSearchState.compressionConfig.embeddingModel
              ? {
                  providerId: webSearchState.compressionConfig.embeddingModel.provider,
                  modelId: webSearchState.compressionConfig.embeddingModel.id,
                  dimensions: webSearchState.compressionConfig.embeddingDimensions
                }
              : undefined,
            // 批次2 rerank 实装：重排模型引用同形收窄（undefined = 不重排）。
            rerank: webSearchState.compressionConfig.rerankModel
              ? {
                  providerId: webSearchState.compressionConfig.rerankModel.provider,
                  modelId: webSearchState.compressionConfig.rerankModel.id
                }
              : undefined
          }
        : undefined
    })
  }, [webSearchState])

  // 批次3 MCP：mcp 切片 servers（配置含命令/env 密钥）整体投影进主进程 MCPService
  // 内存（不落盘不进会话；内核桥挂载时按 serverId 反查）。
  const mcpServers = useAppSelector((state) => state.mcp.servers)

  useEffect(() => {
    void window.api.dshSyncMcpServers(mcpServers ?? [])
  }, [mcpServers])

  // §7.17 三轮 文档处理通道：preprocess 切片 providers（含 apiKey，只进主进程内存，
  // webSearch/MCP 同先例）整体投影进主进程内存配置表——ocr_document 工具与知识库
  // 摄取的扫描件回退按此路由服务商。
  const preprocessProviders = useAppSelector((state) => state.preprocess.providers)

  useEffect(() => {
    void syncPreprocessToKernel(
      (preprocessProviders ?? []).map((provider) => ({
        id: provider.id,
        apiKey: provider.apiKey,
        apiHost: provider.apiHost,
        model: provider.model
      }))
    )
  }, [preprocessProviders])

  useEffect(() => {
    // 把 provider 配置同步进内核（provider 变更时自动重同步）
    void syncProvidersToKernel(kernelProviders)
  }, [kernelProviders])

  useEffect(() => {
    // 转述模型配置同步（v0.3.1 识图通道补全）：变更即推。undefined → null =
    // 通道关闭（describe_images 不挂载，渲染层图片门禁回收现状）；
    // prompt 为 '' = 内置默认提示词。
    void syncImageDescriberToKernel(imageDescriberModel ?? undefined, imageDescriberPrompt ?? '')
  }, [imageDescriberModel, imageDescriberPrompt])

  useEffect(() => {
    void checkDataLimit()
  }, [])
}
