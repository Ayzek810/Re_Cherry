import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useCodeCli } from '@renderer/hooks/useCodeCli'
import { useProviders } from '@renderer/hooks/useProvider'
import { loggerService } from '@logger'
import { toCliProvider } from '../cliConfig/providerView'
import type { CodeCliId } from '@shared/types/codeCliState'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import { CLI_OWN_LOGIN_PROVIDER_ID, CodeCli, GATEWAY_CAPABLE_CLI_TOOLS, isApiGatewayProviderId, LOGIN_CAPABLE_CLI_TOOLS } from '@shared/types/codeCli'

import { clearCliConfig, resolveCliConfigApplyContext } from '../cliConfig'
import type { CodeCliPageViewProps } from '../components/CodeCliPageView'
import { CLI_TOOLS, PROVIDERLESS_CLI_TOOLS } from '../constants/cliTools'
import { OWN_LOGIN_PROVIDER } from '../constants/ownLoginProvider'
import type { CodeToolMeta, VersionStatus } from '../types'
import { useApiGatewayProvider } from './useApiGatewayProvider'
import { useBinaryActions } from './useBinaryActions'
import { useCliVersionStatuses } from './useCliVersionStatuses'
import { useConfigMetadata } from './useConfigMetadata'
import { useConfigPanelController } from './useConfigPanelController'
import { useCurrentCliConfigConnection } from './useCurrentCliConfigConnection'
import { useDeepSeekHarnessController } from './useDeepSeekHarnessController'
import { useHermesDashboardController } from './useHermesDashboardController'
import { useLaunchDialogController } from './useLaunchDialogController'
import { useRemoveCliToolDialog } from './useRemoveCliToolDialog'
import { useSortedSupportedProviders } from './useSortedSupportedProviders'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useCodeCliPageViewProps.ts
//（2026-09-24，v0.3.4-1 批次4b）。缝点八处，装配数据流（summaries/prependedProviders/sorted
// providers/gateway 兜底配置/canLaunch/handleRemove 清理链）逐字：
// ① sidebarShortcuts 段不搬：useSidebarShortcuts/isCliSidebarPinned/toggleCliSidebarShortcut 与
//   sidebarProps.isSidebarPinned/onToggleSidebar 整体裁掉（fork 未建侧栏快捷方式面，批次 5 父代理挂）。
// ② Gemini 臂删除：visibleTools 过滤与选种重定向 effect 随 GEMINI_CLI 裁剪（fork 工具集无该项）。
// ③ OpenClaw 臂删除：useOpenClawGatewayController 未移植（fork 工具集无 OPENCLAW），launching/
//   running/stopping 合成与 onLaunch/onStop/onOpenDashboard 分流收敛到 hermes/deepseek 两臂。
// ④ providers 投影缝：fork useProviders 出 fork 原生 Provider，先过 toCliProvider 投影再入本层
//   全部 hooks（4a 装配点须知）；fork 无 isLoading 面，isProvidersLoading 恒 false。
// ⑤ operation 面缝：fork 快照无 operation 广播面（见 ../types 缝注）——mergedInstallingTools 收敛
//   为本地 busy 集合副本，installError 恒 undefined，onInstall 不带 retry 目标版本。
// ⑥ IPC/toast/logger 缝：window.toast（4a 同款）、'@logger'。
// ⑦ 类型缝：CodeCliId ← @shared/types/codeCliState；Provider/Model 消费面 ← providerView 投影。

const logger = loggerService.withContext('CodeCliPage')

type CliToolOption = (typeof CLI_TOOLS)[number]

const CLI_TOOL_IDS = CLI_TOOLS.map((tool) => tool.value)

export function useCodeCliPageViewProps(
  initialTool?: CodeCli,
  onToolChange?: (tool: CodeCli) => void
): CodeCliPageViewProps {
  const { t } = useTranslation()
  const toMeta = useCallback(
    (tool: CliToolOption): CodeToolMeta => ({
      id: tool.value,
      label: t(tool.label),
      icon: tool.icon
    }),
    [t]
  )
  const {
    configs,
    selectedCliTool,
    currentToolState,
    currentProviderId,
    currentProviderConfig,
    providerConfigs,
    directory,
    upsertProviderConfig,
    deleteProviderConfig,
    setCurrentProvider,
    reorderProviders,
    selectTool,
    selectFolder
  } = useCodeCli(initialTool, onToolChange)

  const { install, upgrade, remove, installingTools, upgradingTools } = useBinaryActions()
  const { providers: forkProviders } = useProviders()
  // fork 缝④（续）：fork 原生 Provider → V2 CLI 消费面（一次性投影，下游全部按 V2 形状消费）。
  const providers = useMemo(() => forkProviders.map(toCliProvider), [forkProviders])
  // fork 缝④（续）：fork useProviders 无 isLoading 面（enabled 集同步快照）。
  const isProvidersLoading = false
  const apiGatewayBundle = useApiGatewayProvider()
  const {
    filterProviders,
    filterProvidersForTool,
    makeModelFilter,
    resolveProviderMeta,
    resolveProviderMetaForTool,
    gatewayModelsById,
    modelById,
    defaultGatewayModelId,
    isGatewayModelsLoading
  } = useConfigMetadata(selectedCliTool, providers, isProvidersLoading)

  // Per-tool enabled-model summary for the sidebar's second line. Falls back to the
  // provider display name when no model applies (own login, Claude detailed models).
  const providerSummaries = useMemo(() => {
    const summaries: Record<string, string> = {}
    for (const tool of CLI_TOOLS) {
      const state = configs[tool.value as CodeCliId]
      const currentId = state?.current
      if (!currentId) continue
      if (currentId === CLI_OWN_LOGIN_PROVIDER_ID) {
        summaries[tool.value] = t('code.own_login.title', { toolName: t(tool.label) })
        continue
      }
      // The gateway is synthetic (absent from the real provider list); resolve its summary
      // from the bundle's provider so the sidebar still shows the selected model.
      const provider = isApiGatewayProviderId(currentId) ? apiGatewayBundle?.provider : providers.find((p) => p.id === currentId)
      if (!provider) continue
      if (!isApiGatewayProviderId(currentId) && filterProvidersForTool(tool.value, [provider]).length === 0) continue
      const meta = resolveProviderMetaForTool(tool.value, provider, state.providers[currentId])
      summaries[tool.value] = meta.modelName || meta.providerName
    }
    return summaries
  }, [configs, providers, apiGatewayBundle, filterProvidersForTool, resolveProviderMetaForTool, t])

  const handleReorderError = useCallback(
    (error: unknown) => {
      logger.error('Failed to reorder CLI providers:', error as Error)
      window.toast.error(t('code.apply_failed'))
    },
    [t]
  )
  // fork 缝②③（续）：LOGIN_CAPABLE_CLI_TOOLS 空集 + 网关 bundle 恒 null → 两个 show 标志在 fork
  // 恒 false（表达式保留 V2 原文形状，prependedProviders 随之为空集）。
  const showOwnLoginCard = LOGIN_CAPABLE_CLI_TOOLS.has(selectedCliTool)
  const showGatewayCard = GATEWAY_CAPABLE_CLI_TOOLS.has(selectedCliTool) && !!apiGatewayBundle
  const prependedProviders = useMemo(
    () =>
      [showGatewayCard ? apiGatewayBundle?.provider : null, showOwnLoginCard ? OWN_LOGIN_PROVIDER : null].filter(
        (p): p is NonNullable<typeof p> => p !== null
      ),
    [showGatewayCard, apiGatewayBundle, showOwnLoginCard]
  )
  const { supportedProviders, onReorder: handleReorder } = useSortedSupportedProviders({
    providers,
    currentToolState,
    selectedCliTool,
    filterProviders,
    reorderProviders,
    onReorderError: handleReorderError,
    prependedProviders
  })

  const selectedProvider = currentProviderId ? supportedProviders.find((p) => p.id === currentProviderId) : undefined
  const currentProviderIsPending = !!currentProviderId && !selectedProvider && isProvidersLoading
  const defaultGatewayProvider =
    !selectedProvider && !currentProviderIsPending && showGatewayCard ? apiGatewayBundle?.provider : undefined
  const savedGatewayConfig = defaultGatewayProvider ? providerConfigs[defaultGatewayProvider.id] : undefined
  const hasSavedGatewayContext = defaultGatewayProvider
    ? !!resolveCliConfigApplyContext(selectedCliTool, defaultGatewayProvider.id, savedGatewayConfig, gatewayModelsById)
    : false
  const defaultGatewayConfig = useMemo(
    () =>
      hasSavedGatewayContext
        ? savedGatewayConfig
        : defaultGatewayModelId
          ? // fork 缝⑦（续）：defaultGatewayModelId 由 fork useConfigMetadata 以 string 面（Model['id']）
            // 出——brand 收窄回 CliProviderConfig.modelId（网关臂在 fork 为 dormant 面，值形状一致）。
            { ...savedGatewayConfig, modelId: defaultGatewayModelId as CliProviderConfig['modelId'] }
          : null,
    [hasSavedGatewayContext, savedGatewayConfig, defaultGatewayModelId]
  )
  const enabledProvider = selectedProvider ?? defaultGatewayProvider
  const enabledProviderConfig = selectedProvider ? currentProviderConfig : defaultGatewayConfig
  const {
    connection: currentCliConfigConnection,
    setConnection: setCurrentCliConfigConnection,
    reload: reloadCliConfigConnection
  } = useCurrentCliConfigConnection({
    enabledProvider,
    selectedCliTool,
    currentProviderConfig: enabledProviderConfig,
    apiGatewayProvider: apiGatewayBundle
  })

  const { statuses } = useCliVersionStatuses(CLI_TOOL_IDS)
  // fork 缝②（续）：无 GEMINI_CLI 可见性过滤与选种重定向（fork 工具集恒显 2 项）；statuses 的
  // resolved 标志随重定向 effect 一并裁掉。
  const visibleTools = CLI_TOOLS
  const activeTool = useMemo<CliToolOption | undefined>(
    () => visibleTools.find((tool) => tool.value === selectedCliTool),
    [selectedCliTool, visibleTools]
  )
  const isProviderlessTool = PROVIDERLESS_CLI_TOOLS.has(selectedCliTool)
  const isOwnLoginSelected = selectedProvider?.id === CLI_OWN_LOGIN_PROVIDER_ID
  const isDeepSeekHarnessTool = selectedCliTool === CodeCli.DEEPSEEK_HARNESS
  const isHermesDashboardTool = selectedCliTool === CodeCli.HERMES
  const activeMeta = activeTool ? toMeta(activeTool) : null
  const toolName = activeMeta?.label ?? ''
  // Local busy Sets give instant feedback; snapshot operations cover mutations
  // initiated in another window or before this page mounted.
  // fork 缝⑤（续）：fork 快照无 operation 面，快照侧不补装态。
  const mergedInstallingTools = useMemo(() => new Set<string>(installingTools), [installingTools])
  const versionStatus: VersionStatus = statuses[selectedCliTool] ?? {
    installed: false,
    source: 'none',
    canUpgrade: false
  }
  const canLaunch = isHermesDashboardTool
    ? versionStatus.installed
    : (isProviderlessTool || isOwnLoginSelected || !!enabledProvider) &&
      (!isDeepSeekHarnessTool || !!enabledProviderConfig?.modelId)
  // fork 缝⑤（续）：无 operation 失败面 → 无 install error 对话框来源；保留 undefined 形状。
  const installError: string | undefined = undefined
  // The synthetic own-login entry is always available, so nudge to "select a provider" only when a
  // real provider exists to select — otherwise own-login is the sole option and no nag is warranted.
  const hasRealSupportedProvider = supportedProviders.some((p) => p.id !== CLI_OWN_LOGIN_PROVIDER_ID)
  const showProviderSelectionHint =
    versionStatus.installed &&
    !isProviderlessTool &&
    hasRealSupportedProvider &&
    !selectedProvider &&
    !currentProviderIsPending &&
    !defaultGatewayProvider

  const configPanel = useConfigPanelController({
    selectedCliTool,
    toolName,
    currentProviderId,
    providerConfigs,
    upsertProviderConfig,
    deleteProviderConfig,
    setCurrentProvider,
    setCurrentCliConfigConnection,
    makeModelFilter,
    apiGatewayProvider: apiGatewayBundle,
    gatewayModelsById,
    isGatewayModelsLoading
  })
  const launchDialog = useLaunchDialogController({
    selectedCliTool,
    toolName,
    directory,
    enabledProvider,
    isOwnLoginSelected,
    currentProviderConfig: enabledProviderConfig,
    apiGatewayProvider: apiGatewayBundle,
    gatewayModelsById,
    modelById,
    isModelsLoading: isGatewayModelsLoading,
    upsertProviderConfig,
    setCurrentProvider,
    selectFolder
  })
  const deepSeekHarness = useDeepSeekHarnessController({
    selectedCliTool,
    enabledProvider,
    currentProviderConfig: enabledProviderConfig,
    upsertProviderConfig,
    setCurrentProvider
  })
  const hermesDashboard = useHermesDashboardController(selectedCliTool, {
    onConfigMayHaveChanged: reloadCliConfigConnection
  })
  const deepSeekHarnessActionsDisabled =
    isDeepSeekHarnessTool && (deepSeekHarness.running || deepSeekHarness.starting || deepSeekHarness.stopping)
  const hermesDashboardActionsDisabled =
    isHermesDashboardTool && (hermesDashboard.running || hermesDashboard.starting || hermesDashboard.stopping)
  const providerActionsDisabled = deepSeekHarnessActionsDisabled || hermesDashboardActionsDisabled
  const handleRemove = useCallback(
    async (toolId: CodeCli) => {
      if (toolId === CodeCli.DEEPSEEK_HARNESS && !(await deepSeekHarness.onStop())) return
      if (toolId === CodeCli.HERMES && !(await hermesDashboard.onStop())) return
      const success = await remove(toolId)
      if (success && currentProviderId) {
        if (toolId !== CodeCli.DEEPSEEK_HARNESS) {
          try {
            await clearCliConfig({ cliTool: toolId })
          } catch (err) {
            logger.error('Failed to clear CLI config on tool removal:', err as Error)
            window.toast.error(t('code.clear_config_failed'))
          }
        }
        await setCurrentProvider(null)
        setCurrentCliConfigConnection(null)
      }
    },
    [deepSeekHarness, hermesDashboard, remove, currentProviderId, setCurrentProvider, setCurrentCliConfigConnection, t]
  )
  const removeDialog = useRemoveCliToolDialog({ toolName, remove: handleRemove })

  return {
    sidebarProps: {
      tools: visibleTools,
      selectedCliTool,
      onSelectTool: selectTool,
      toMeta,
      statuses,
      installingTools: mergedInstallingTools,
      upgradingTools,
      providerSummaries
    },
    contentProps: activeMeta
      ? {
          selectedCliTool,
          activeMeta,
          versionStatus,
          versionCard: {
            visible: true,
            canLaunch,
            launching:
              launchDialog.launching ||
              deepSeekHarness.launching ||
              deepSeekHarness.starting ||
              hermesDashboard.launching ||
              hermesDashboard.starting,
            running: deepSeekHarness.running || hermesDashboard.running,
            stopping: deepSeekHarness.stopping || hermesDashboard.stopping,
            upgradeDisabled: providerActionsDisabled
          },
          installingTools: mergedInstallingTools,
          upgradingTools,
          installError,
          providerState: {
            providerless: isProviderlessTool,
            showSelectionHint: showProviderSelectionHint
          },
          supportedProviders,
          providerConfigs,
          currentProviderId,
          currentProviderModelName: currentCliConfigConnection ? t('code.cli_config.unknown_provider') : undefined,
          providerActionsDisabled,
          resolveProviderMeta,
          // fork 缝⑤（续）：无失败目标的 retry 面；name-only 安装即 fork 安装器的全部语义。
          onInstall: () => void install(selectedCliTool),
          onUpgrade: () => void upgrade(selectedCliTool, versionStatus.latest),
          // Uninstall authority is the live application fact: offer removal only
          // when the fixed CLI's exact recipe is applied or broken.
          onRemove:
            versionStatus.applicationStatus === 'applied' || versionStatus.applicationStatus === 'broken'
              ? () => removeDialog.requestRemove(selectedCliTool)
              : undefined,
          onLaunch: () =>
            isHermesDashboardTool
              ? void hermesDashboard.onLaunch()
              : defaultGatewayProvider && !defaultGatewayConfig
                ? configPanel.onToggleCurrent(defaultGatewayProvider)
                : isDeepSeekHarnessTool
                  ? void deepSeekHarness.onLaunch()
                  : launchDialog.openLaunchDialog(),
          onStop: () =>
            isDeepSeekHarnessTool
              ? void deepSeekHarness.onStop()
              : void hermesDashboard.onStop(),
          onOpenDashboard: () =>
            isDeepSeekHarnessTool
              ? void deepSeekHarness.onOpenWebUi()
              : void hermesDashboard.onOpenDashboard(),
          onConfigure: configPanel.openConfigurePanel,
          onToggleCurrent: configPanel.onToggleCurrent,
          onReorder: handleReorder
        }
      : undefined,
    emptyMessage: t('code.select_tool_to_start'),
    launchDialogProps: launchDialog.launchDialogProps,
    removeDialogProps: removeDialog.removeDialogProps,
    configPanelKey: configPanel.configPanelKey,
    configPanelProps: providerActionsDisabled ? undefined : configPanel.configPanelProps,
    ownLoginConfigPanelProps: configPanel.ownLoginConfigPanelProps
  }
}
