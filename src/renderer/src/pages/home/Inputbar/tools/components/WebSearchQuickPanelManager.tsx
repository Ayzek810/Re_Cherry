/**
 * v0.3.2 自 CS_V1 移植（联网搜索 QuickPanel 面板管理器）。
 * 批次2（接线）改动点：
 * - 搜索可用性判据换 WebSearchService.isWebSearchEnabled 全量语义（local- 恒可用 /
 *   key 型看 apiKey / host 型看 apiHost），未就绪项不进面板；
 * - 提供商 logo 已随 SVGIcon 逐字移植（Bing/SearXNG/Tavily/Exa/Bocha/Zhipu/Querit +
 *   antd 的 Baidu/Google），未识别 id 走 Globe 兜底；
 * - Gemini3/MCP 冲突检查未移植（依赖 fork 已删的上游工具面判据），按内核语义重写时
 *   再评估；保留 OpenAI minimal-reasoning 冲突警告（判据在本仓 config/models）。
 */
import { BaiduOutlined, GoogleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import {
  BingLogo,
  BochaLogo,
  ExaLogo,
  QueritLogo,
  SearXNGLogo,
  TavilyLogo,
  ZhipuLogo
} from '@renderer/components/Icons'
import type { QuickPanelListItem } from '@renderer/components/QuickPanel'
import { QuickPanelReservedSymbol } from '@renderer/components/QuickPanel'
import { isGPT5SeriesReasoningModel, isOpenAIWebSearchModel, isWebSearchModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useTimer } from '@renderer/hooks/useTimer'
import { useWebSearchProviders } from '@renderer/hooks/useWebSearchProviders'
import type { ToolQuickPanelController, ToolRenderContext } from '@renderer/pages/home/Inputbar/types'
import { isWebSearchEnabled } from '@renderer/services/WebSearchService'
import type { WebSearchProvider, WebSearchProviderId } from '@renderer/types'
import { hasObjectKey } from '@renderer/utils'
import { Globe } from 'lucide-react'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('WebSearchQuickPanel')

export const WebSearchProviderIcon = ({
  pid,
  size = 18,
  color
}: {
  pid?: WebSearchProviderId
  size?: number
  color?: string
}) => {
  switch (pid) {
    case 'bocha':
      return <BochaLogo className="icon" width={size} height={size} color={color} />
    case 'exa':
      return <ExaLogo className="icon" width={size - 2} height={size} color={color} />
    case 'tavily':
      return <TavilyLogo className="icon" width={size} height={size} color={color} />
    case 'zhipu':
      return <ZhipuLogo className="icon" width={size} height={size} color={color} />
    case 'searxng':
      return <SearXNGLogo className="icon" width={size} height={size} color={color} />
    case 'querit':
      return <QueritLogo className="icon" width={size} height={size} color={color} />
    case 'local-baidu':
      return <BaiduOutlined size={size} style={{ color, fontSize: size }} />
    case 'local-bing':
      return <BingLogo className="icon" width={size} height={size} color={color} />
    case 'local-google':
      return <GoogleOutlined size={size} style={{ color, fontSize: size }} />
    default:
      return <Globe className="icon" size={size} style={{ color, fontSize: size }} />
  }
}

export const useWebSearchPanelController = (assistantId: string, quickPanelController: ToolQuickPanelController) => {
  const { t } = useTranslation()
  const { assistant, updateAssistant } = useAssistant(assistantId)
  const { providers } = useWebSearchProviders()
  const { setTimeoutTimer } = useTimer()

  const enableWebSearch = assistant?.webSearchProviderId || assistant.enableWebSearch

  const updateWebSearchProvider = useCallback(
    async (providerId?: WebSearchProvider['id']) => {
      setTimeoutTimer('updateWebSearchProvider', () => {
        updateAssistant({
          ...assistant,
          webSearchProviderId: providerId,
          enableWebSearch: false
        })
      })
    },
    [assistant, setTimeoutTimer, updateAssistant]
  )

  const updateQuickPanelItem = useCallback(
    async (providerId?: WebSearchProvider['id']) => {
      if (providerId === assistant.webSearchProviderId) {
        void updateWebSearchProvider(undefined)
      } else {
        void updateWebSearchProvider(providerId)
      }
    },
    [assistant.webSearchProviderId, updateWebSearchProvider]
  )

  const updateToModelBuiltinWebSearch = useCallback(async () => {
    const update = {
      ...assistant,
      webSearchProviderId: undefined,
      enableWebSearch: !assistant.enableWebSearch
    }
    const model = assistant.model
    if (!model) {
      logger.error('Model does not exist.')
      window.toast.error(t('error.model.not_exists'))
      return
    }
    if (
      isOpenAIWebSearchModel(model) &&
      isGPT5SeriesReasoningModel(model) &&
      update.enableWebSearch &&
      assistant.settings?.reasoning_effort === 'minimal'
    ) {
      update.enableWebSearch = false
      window.toast.warning(t('chat.web_search.warning.openai'))
    }
    setTimeoutTimer('updateSelectedWebSearchBuiltin', () => updateAssistant(update), 200)
  }, [assistant, setTimeoutTimer, t, updateAssistant])

  const providerItems = useMemo<QuickPanelListItem[]>(() => {
    const isWebSearchModelEnabled = !!assistant.model && isWebSearchModel(assistant.model)
    const items: QuickPanelListItem[] = []
    items.push(
      ...providers
        .filter((p) => isWebSearchEnabled(p.id))
        .map((p) => ({
          label: p.name,
          // 就绪过滤后：本地搜索（无 apiKey 键）→ 免费；云端（已填 key）→ 已配置密钥
          description: hasObjectKey(p, 'apiKey')
            ? t('settings.tool.websearch.apikey')
            : t('settings.tool.websearch.free'),
          icon: <WebSearchProviderIcon size={13} pid={p.id} />,
          isSelected: p.id === assistant?.webSearchProviderId,
          action: () => updateQuickPanelItem(p.id)
        }))
    )

    if (isWebSearchModelEnabled) {
      items.unshift({
        label: t('chat.input.web_search.builtin.label'),
        description: t('chat.input.web_search.builtin.enabled_content'),
        icon: <Globe />,
        isSelected: assistant.enableWebSearch,
        action: () => updateToModelBuiltinWebSearch()
      })
    }

    return items
  }, [assistant, providers, t, updateQuickPanelItem, updateToModelBuiltinWebSearch])

  const openQuickPanel = useCallback(() => {
    quickPanelController.open({
      title: t('chat.input.web_search.label'),
      list: providerItems,
      symbol: QuickPanelReservedSymbol.WebSearch,
      pageSize: 9
    })
  }, [providerItems, quickPanelController, t])

  const toggleQuickPanel = useCallback(() => {
    if (quickPanelController.isVisible && quickPanelController.symbol === QuickPanelReservedSymbol.WebSearch) {
      quickPanelController.close()
    } else {
      openQuickPanel()
    }
  }, [openQuickPanel, quickPanelController])

  return {
    enableWebSearch,
    providerItems,
    openQuickPanel,
    toggleQuickPanel,
    updateWebSearchProvider,
    updateToModelBuiltinWebSearch,
    selectedProviderId: assistant.webSearchProviderId
  }
}

interface ManagerProps {
  context: ToolRenderContext<any, any>
}

const WebSearchQuickPanelManager = ({ context }: ManagerProps) => {
  const { assistant, quickPanel, quickPanelController, t } = context
  const { providerItems, openQuickPanel } = useWebSearchPanelController(assistant.id, quickPanelController)
  const { registerRootMenu, registerTrigger } = quickPanel
  const { updateList, isVisible, symbol } = quickPanelController

  useEffect(() => {
    if (isVisible && symbol === QuickPanelReservedSymbol.WebSearch) {
      updateList(providerItems)
    }
  }, [isVisible, providerItems, symbol, updateList])

  useEffect(() => {
    const disposeMenu = registerRootMenu([
      {
        label: t('chat.input.web_search.label'),
        description: '',
        icon: <Globe size={18} />,
        isMenu: true,
        action: () => openQuickPanel()
      }
    ])

    const disposeTrigger = registerTrigger(QuickPanelReservedSymbol.WebSearch, () => openQuickPanel())

    return () => {
      disposeMenu()
      disposeTrigger()
    }
  }, [openQuickPanel, registerRootMenu, registerTrigger, t])

  return null
}

export default WebSearchQuickPanelManager
