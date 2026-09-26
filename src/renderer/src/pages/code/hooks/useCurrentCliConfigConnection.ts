import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loggerService } from '@logger'
import { useProviders } from '@renderer/hooks/useProvider'
import { getStoreProviders } from '@renderer/hooks/useStore'
import { CLI_OWN_LOGIN_PROVIDER_ID, isApiGatewayProviderId, type CodeCli } from '@shared/types/codeCli'
import type { CliProviderConfig } from '@shared/types/codeCliState'

import {
  type ApiKeyEntry,
  type CliConfigConnection,
  cliConfigConnectionMatchesProvider,
  extractConnectionFromCliConfigDraft,
  gatewayExpectedModel,
  readCliConfigFiles,
  resolveCliConfigApplyContext
} from '../cliConfig'
import type { Provider } from '../cliConfig/providerView'
import { safeCreateUniqueModelId } from '../cliConfig/values'
import type { ApiGatewayProviderBundle } from './useApiGatewayProvider'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useCurrentCliConfigConnection.ts
//（2026-09-24，v0.3.4-1 批次4a）。缝点三处，读-比-置数据流（generation/cancelled 竞态守卫）逐字：
// ① keys 缝：V2 经 DataApi `dataApiService.get('/providers/{id}/api-keys')` 读 provider 密钥表
//   ← fork provider 无独立 keys 表（单 apiKey 字段，redux llm 快照为真源），构造同形单条
//   ApiKeyEntry。
// ② 模型源缝：V2 useModels({enabled:true}) ← fork useProviders 自带 models；gateway 分支的
//   apiModelId 解析按 UniqueModelId 键（createUniqueModelId(provider, id)）比对。
// ③ import 对号：Provider/ApiKeyEntry ← providerView/providerMatching 投影面（4b 装配点
//   先经 toCliProvider 投影再入本层）。

const logger = loggerService.withContext('useCurrentCliConfigConnection')

// fork 缝①：V2 为 `const result = await dataApiService.get(`/providers/${providerId}/api-keys`);
// return result?.keys ?? []`。
async function readProviderApiKeys(providerId: string): Promise<ApiKeyEntry[]> {
  const apiKey = getStoreProviders().find((p) => p.id === providerId)?.apiKey
  return apiKey ? [{ id: 'default', key: apiKey, isEnabled: true }] : []
}

export function useCurrentCliConfigConnection({
  enabledProvider,
  selectedCliTool,
  currentProviderConfig,
  apiGatewayProvider
}: {
  enabledProvider?: Provider
  selectedCliTool: CodeCli
  currentProviderConfig?: CliProviderConfig | null
  apiGatewayProvider?: ApiGatewayProviderBundle | null
}): {
  connection: CliConfigConnection | null
  setConnection: (connection: CliConfigConnection | null) => void
  reload: () => void
} {
  const [currentCliConfigConnection, setCurrentCliConfigConnection] = useState<CliConfigConnection | null>(null)
  const [reloadRevision, setReloadRevision] = useState(0)
  const readGenerationRef = useRef(0)
  // fork 缝②：V2 为 `const { models } = useModels({ enabled: true })`。
  const { providers } = useProviders()
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])
  const reload = useCallback(() => setReloadRevision((revision) => revision + 1), [])

  const isGateway = !!enabledProvider && isApiGatewayProviderId(enabledProvider.id)
  const gatewayApiKey = apiGatewayProvider?.apiKey ?? null
  // Resolve the gateway model's apiModelId to a primitive so the effect re-runs only when it changes.
  // fork 缝②：fork 模型无 UniqueModelId 字段，按 provider::id 键比对；命中即取 wire id（fork
  // 模型 id 本身就是 wire id，与 V2 apiModelId 语义对位）。
  const gatewayApiModelId = useMemo(() => {
    if (!isGateway) return undefined
    const modelId = currentProviderConfig?.modelId
    if (!modelId) return undefined
    return models.find((m) => safeCreateUniqueModelId(m.provider, m.id) === modelId)?.id
  }, [isGateway, currentProviderConfig?.modelId, models])

  useEffect(() => {
    const readGeneration = ++readGenerationRef.current
    let cancelled = false
    // The virtual own-login entry has no app-side credential to reconcile against a CLI config file.
    if (!enabledProvider || enabledProvider.id === CLI_OWN_LOGIN_PROVIDER_ID) {
      setCurrentCliConfigConnection(null)
      return
    }

    void (async () => {
      const files = await readCliConfigFiles(selectedCliTool)
      const connection = extractConnectionFromCliConfigDraft(selectedCliTool, files)
      if (!connection) {
        if (!cancelled && readGeneration === readGenerationRef.current) setCurrentCliConfigConnection(null)
        return
      }
      // Gateway: match against the synthetic gateway key (no DataApi record) and the gateway-addressed
      // model, so a live gateway config lights up as active rather than showing as a foreign connection.
      let apiKeys: ApiKeyEntry[]
      let expectedModel: string | undefined
      if (isGateway) {
        apiKeys = gatewayApiKey ? [{ id: 'gateway', key: gatewayApiKey, isEnabled: true }] : []
        expectedModel = gatewayExpectedModel(currentProviderConfig?.modelId, gatewayApiModelId)
      } else {
        apiKeys = await readProviderApiKeys(enabledProvider.id)
        const currentCliConfigContext = resolveCliConfigApplyContext(
          selectedCliTool,
          enabledProvider.id,
          currentProviderConfig ?? undefined
        )
        expectedModel = currentCliConfigContext?.writePrimaryModel ? currentCliConfigContext.rawModelId : undefined
      }
      if (cancelled || readGeneration !== readGenerationRef.current) return
      setCurrentCliConfigConnection(
        cliConfigConnectionMatchesProvider(selectedCliTool, connection, enabledProvider, apiKeys, expectedModel)
          ? null
          : connection
      )
    })().catch((error) => {
      logger.error('Failed to read current CLI config connection:', error as Error)
      if (!cancelled && readGeneration === readGenerationRef.current) setCurrentCliConfigConnection(null)
    })

    return () => {
      cancelled = true
    }
  }, [
    enabledProvider,
    selectedCliTool,
    currentProviderConfig,
    isGateway,
    gatewayApiKey,
    gatewayApiModelId,
    reloadRevision
  ])

  return { connection: currentCliConfigConnection, setConnection: setCurrentCliConfigConnection, reload }
}
