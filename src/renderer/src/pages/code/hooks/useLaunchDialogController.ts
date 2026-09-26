import type { ComponentProps } from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import type { UniqueModelId } from '@shared/types/uniqueModelId'
import { CodeCli, isApiGatewayProviderId } from '@shared/types/codeCli'
import { isFileConfiguredCli } from '@shared/utils/cliConfig'

import {
  type CliConfigFileDraft,
  extractConfigFromCliConfigDraft,
  extractConnectionFromCliConfigDraft,
  gatewayExpectedModel,
  gatewayModelIdFromAddress,
  readCliConfigFiles,
  resolveCliConfigApplyContext,
  writeCliConfigDraft
} from '../cliConfig'
import type { Model, Provider } from '../cliConfig/providerView'
import { PROVIDERLESS_CLI_TOOLS } from '../constants/cliTools'
import type { LaunchDialog } from '../components/LaunchDialog'
import type { ApiGatewayProviderBundle } from './useApiGatewayProvider'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useLaunchDialogController.ts
//（2026-09-24，v0.3.4-1 批次4b）。缝点四处，launch 前置校验（目录/provider 门）、网关复核
//（re-verify + reconcile + writeCliConfigDraft）与 modelById/gatewayModelsById 解析逐字：
// ① 外部终端面不搬：useAvailableTerminals/selectedTerminal/effectiveTerminal/setTerminal 与
//   run 载荷的 `terminal` 字段整体裁掉（dsh/hermes 为受管 Web UI，不消费外部终端——见
//   useAvailableTerminals 缝注）。
// ② IPC 缝：`ipcApi.request('code_cli.run', …)` fork 主进程未建（保留工具经 deepseekHarness/
//   hermesDashboard 启动通道在页面装配处分流，本控制器的 run 臂对保留工具为 dormant 面）——
//   此处收敛为记录日志 + 启动失败 toast，V2 的 runResult.success 判定形状保留在注释里。
// ③ toast 缝：`@renderer/services/toast` → fork `window.toast`；logger 缝：'@logger'。
// ④ 类型缝：CliProviderConfig/UniqueModelId ← @shared 对口面；Model/Provider ← providerView 投影。

const logger = loggerService.withContext('useLaunchDialogController')

interface UseLaunchDialogControllerOptions {
  selectedCliTool: CodeCli
  toolName: string
  directory?: string
  enabledProvider?: Provider
  isOwnLoginSelected: boolean
  currentProviderConfig?: CliProviderConfig | null
  /** Synthetic Cherry gateway bundle — used to re-verify/rebuild the gateway config before launch. */
  apiGatewayProvider?: ApiGatewayProviderBundle | null
  /** Models currently available through the gateway, keyed by UniqueModelId. */
  gatewayModelsById: Map<UniqueModelId, Model>
  /** Every enabled model, keyed by UniqueModelId — the direct-launch counterpart of the map above. */
  modelById: Map<UniqueModelId, Model>
  /** True while the model query is in flight, when a miss in either map above proves nothing. */
  isModelsLoading: boolean
  upsertProviderConfig: (
    providerId: string,
    partial: Pick<CliProviderConfig, 'modelId'> & Partial<CliProviderConfig>
  ) => Promise<string>
  setCurrentProvider: (providerId: string | null) => Promise<void>
  selectFolder: () => Promise<string | null>
}

interface LaunchDialogController {
  launchDialogProps: ComponentProps<typeof LaunchDialog>
  launching: boolean
  openLaunchDialog: () => void
}

export function useLaunchDialogController({
  selectedCliTool,
  toolName,
  directory,
  enabledProvider,
  isOwnLoginSelected,
  currentProviderConfig,
  apiGatewayProvider,
  gatewayModelsById,
  modelById,
  isModelsLoading,
  upsertProviderConfig,
  setCurrentProvider,
  selectFolder
}: UseLaunchDialogControllerOptions): LaunchDialogController {
  const { t } = useTranslation()
  const [launchOpen, setLaunchOpen] = useState(false)
  const [launching, setLaunching] = useState(false)

  const handleSelectFolder = useCallback(async () => {
    try {
      await selectFolder()
    } catch (err) {
      logger.error('Failed to select folder:', err as Error)
    }
  }, [selectFolder])

  // The CLI config file is written at "enable" time, not here — launch only
  // opens a terminal running the CLI in the provider's directory. Provider-less
  // tools (qoder / copilot) launch with a directory only.
  const handleLaunch = useCallback(async () => {
    // Provider-less tools (qoder/copilot) and the virtual "own login" option both
    // launch with a directory only — no Cherry provider/model is injected.
    const runWithoutProvider = PROVIDERLESS_CLI_TOOLS.has(selectedCliTool) || isOwnLoginSelected
    if (!directory || (!runWithoutProvider && !enabledProvider)) {
      window.toast.error(t('code.folder_placeholder'))
      return
    }
    if (runWithoutProvider) {
      try {
        setLaunching(true)
        // fork 缝②：V2 为 `ipcApi.request('code_cli.run', {mode:'own-login', cliTool, directory, terminal})`
        // 后按 `runResult.success` 关窗/报错；fork 无该通道（见文件头缝注②），此臂 dormant。
        logger.error('Failed to launch CLI tool:', new Error('code_cli.run channel is not available in fork'))
        window.toast.error(t('code.launch.error'))
      } finally {
        setLaunching(false)
      }
      return
    }

    const isGatewayProvider = !!enabledProvider && isApiGatewayProviderId(enabledProvider.id)
    const cliConfigContext = enabledProvider
      ? resolveCliConfigApplyContext(
          selectedCliTool,
          enabledProvider.id,
          currentProviderConfig ?? undefined,
          isGatewayProvider ? gatewayModelsById : undefined
        )
      : null
    if (!cliConfigContext) {
      logger.error('Invalid CLI model id configured for launch', {
        modelId: currentProviderConfig?.modelId,
        toolId: selectedCliTool,
        providerId: enabledProvider?.id
      })
      // Gateway resolution depends on the live model query, so a miss may be transient. Preserve
      // the saved gateway selection and let the user retry instead of treating it as corrupt data.
      if (!isGatewayProvider) {
        if (enabledProvider) {
          await upsertProviderConfig(enabledProvider.id, { modelId: null })
        }
        await setCurrentProvider(null)
      }
      window.toast.error(t('code.launch.validation_error'))
      return
    }

    try {
      setLaunching(true)
      // The gateway may have been stopped or re-keyed/re-ported since "enable" wrote the CLI
      // config; re-verify it's serving and rewrite the config with the configured context so the
      // CLI never launches against a dead endpoint.
      // A miss only means "gone" once the query has settled; on a cold map it would silently
      // hand the CLI the internal id instead of the provider-facing apiModelId.
      if (isModelsLoading) {
        throw new Error('Model list is still loading')
      }
      // Every launch, not just the file-configured ones: the reconciliation below skips tools
      // like Antigravity, so a stale selection would start a session that cannot route.
      const launchModelRecord = (isGatewayProvider ? gatewayModelsById : modelById).get(cliConfigContext.modelId)
      if (!launchModelRecord) {
        throw new Error(`Model is no longer available: ${cliConfigContext.modelId}`)
      }
      if (isGatewayProvider && apiGatewayProvider) {
        await apiGatewayProvider.ensureRunning()
      }
      if (isGatewayProvider && apiGatewayProvider && isFileConfiguredCli(selectedCliTool)) {
        const apiKey = await apiGatewayProvider.getApiKey()
        let onDiskFiles: CliConfigFileDraft[] | undefined
        try {
          onDiskFiles = await readCliConfigFiles(selectedCliTool)
        } catch (err) {
          // Reading is only needed to preserve a raw gateway model. If it fails, rebuild the managed
          // config from preference so launch still uses the current gateway connection.
          logger.warn('Failed to read CLI config for gateway reconciliation; rewriting', err as Error)
        }

        let modelId = cliConfigContext.modelId
        let configBlob = currentProviderConfig?.config
        let mergeFiles: CliConfigFileDraft[] | undefined
        if (onDiskFiles) {
          const onDiskModel = extractConnectionFromCliConfigDraft(selectedCliTool, onDiskFiles)?.model
          const expectedModel = gatewayExpectedModel(
            cliConfigContext.modelId,
            gatewayModelsById.get(cliConfigContext.modelId)?.apiModelId
          )
          if (onDiskModel && expectedModel && onDiskModel !== expectedModel) {
            const onDiskModelId = gatewayModelIdFromAddress(onDiskModel, gatewayModelsById)
            if (!onDiskModelId) {
              throw new Error(`Cannot resolve gateway model from CLI config: ${onDiskModel}`)
            }
            modelId = onDiskModelId
            configBlob = extractConfigFromCliConfigDraft(selectedCliTool, onDiskFiles) ?? configBlob
            mergeFiles = onDiskFiles
          }
        }
        if (!gatewayModelsById.has(modelId)) {
          throw new Error(`Gateway model is no longer available: ${modelId}`)
        }
        await writeCliConfigDraft({
          cliTool: selectedCliTool,
          modelId,
          configBlob,
          ...(mergeFiles ? { files: mergeFiles } : {}),
          writePrimaryModel: cliConfigContext.writePrimaryModel,
          gateway: { provider: apiGatewayProvider.provider, apiKey }
        })
      }
      // Both routes address a model by its provider-facing apiModelId: the gateway matches on it,
      // and a direct launch hands it straight to the provider's own API. A record without one
      // legitimately falls back to the raw id — unlike a missing record, rejected above.
      const launchModel = launchModelRecord.apiModelId ?? cliConfigContext.rawModelId
      // fork 缝②（续）：V2 为 `ipcApi.request('code_cli.run', {mode:'normal', cliTool, model:
      // launchModel, providerId, gateway, directory, terminal})` 后按 `runResult.success`
      // 关窗/报错；fork 无该通道，此臂 dormant——模型已解析的事实保留在日志里便于回填排障。
      logger.info('code_cli.run payload resolved (fork: channel not available)', {
        cliTool: selectedCliTool,
        model: launchModel,
        providerId: cliConfigContext.providerId,
        gateway: isGatewayProvider,
        directory
      })
      window.toast.error(t('code.launch.error'))
    } catch (err) {
      logger.error('Failed to launch CLI tool:', err as Error)
      window.toast.error(t('code.launch.error'))
    } finally {
      setLaunching(false)
    }
  }, [
    currentProviderConfig,
    directory,
    enabledProvider,
    isOwnLoginSelected,
    upsertProviderConfig,
    selectedCliTool,
    apiGatewayProvider,
    gatewayModelsById,
    modelById,
    isModelsLoading,
    setCurrentProvider,
    t
  ])

  return {
    launchDialogProps: {
      open: launchOpen,
      onClose: () => setLaunchOpen(false),
      toolName,
      directory,
      onSelectFolder: () => void handleSelectFolder(),
      onLaunch: () => void handleLaunch(),
      launching
    },
    launching,
    openLaunchDialog: () => setLaunchOpen(true)
  }
}
