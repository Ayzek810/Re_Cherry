// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useApiGatewayProvider.ts
//（2026-09-24，v0.3.4-1 批次5 由批次4a 的 dormant 桩转正）。V2 结构（合成 provider /
// ensureRunning / getApiKey）逐字；数据源缝三处，均已标注：
// ① V2 useApiGateway（preference 面）→ fork `window.api.codeCli.apiGateway.getConfig()`
//   （批次5 新增读通道：ConfigManager 四键 + running，apiKey 只读不生成——V2 语义
//   "网关从未启动过则为 null"）+ useApiGatewayStatus（运行态订阅）；
// ② V2 Provider/ENDPOINT_TYPE → fork cliConfig/providerView 的最小结构（端点字面量同值）；
// ③ fork Provider 形状无 authType/settings/reportsActualCost（V2 独有装饰字段，不投影），
//   apiKeys 携带 key 值（fork providerView 契约：key 值由构造方注入）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CLI_API_GATEWAY_PROVIDER_ID } from '@shared/types/codeCli'
import { gatewayClientOrigin } from '@shared/utils/apiGateway'

import type { Provider } from '../cliConfig/providerView'
import { useApiGatewayStatus } from './useCodeCliStatus'

const DEFAULT_GATEWAY_HOST = '127.0.0.1'
const DEFAULT_GATEWAY_PORT = 23333

interface GatewayConfig {
  host: string
  port: number
  apiKey: string | null
  running: boolean
}

/**
 * The synthetic "Cherry Gateway" entry for the code-CLI provider list, plus the
 * live gateway credential and a lifecycle action. The `provider` flows through the
 * normal provider pipeline (card / model picker / config write), so its
 * `endpointConfigs` point at the local gateway and its `apiKeys` carry a runtime
 * placeholder (the secret lives on `apiKey`, since `Provider.apiKeys` omits key
 * values by schema).
 */
export interface ApiGatewayProviderBundle {
  provider: Provider
  /** Current persisted gateway key; `null` before the gateway has ever started (main generates it lazily). */
  apiKey: string | null
  /** Start the gateway if needed and confirm it is running. */
  ensureRunning: () => Promise<void>
  /** Read the persisted key for a CLI config-file write. */
  getApiKey: () => Promise<string>
}

/**
 * Build the synthetic Cherry Gateway provider from the API-gateway preference
 * config. Returns `null` only when host/port are unavailable (never, given the
 * shipped defaults) so the gateway card is always offered for gateway-capable
 * tools. The provider is rebuilt whenever host/port/key change.
 */
export function useApiGatewayProvider(): ApiGatewayProviderBundle | null {
  const { t } = useTranslation()
  const { running } = useApiGatewayStatus()

  // fork 缝①：config 快照（host/port/apiKey）——mount 拉一次 + running 翻转时重拉
  //（key 在 start 流程内懒生成，启动后才能读到）。
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const refreshConfig = useCallback(async (): Promise<void> => {
    try {
      setConfig((await window.api.codeCli.apiGateway.getConfig()) as GatewayConfig)
    } catch {
      // 保形上次快照（与 V2 的 stale-while-revalidate 姿态一致）。
    }
  }, [])
  useEffect(() => {
    void refreshConfig()
  }, [refreshConfig])
  useEffect(() => {
    if (running) void refreshConfig()
  }, [running, refreshConfig])

  const host = config?.host || DEFAULT_GATEWAY_HOST
  const port = config?.port || DEFAULT_GATEWAY_PORT
  const apiKey = config?.apiKey ?? null

  const ensureRunning = useCallback(async (): Promise<void> => {
    if (!running) {
      // Main persists the key in the start flow BEFORE the server binds, and it survives a
      // stop — so a key can exist while nothing is listening. Only proceed when the start
      // actually confirmed the server is running; otherwise the caller must not write the
      // CLI config or mark the gateway current against a dead port. `start` returns
      // { success: false, error } on failure (it never rejects).
      const started = (await window.api.codeCli.apiGateway.start()) as { success?: boolean } | undefined
      if (!started?.success) {
        throw new Error('API gateway failed to start')
      }
    }
    await refreshConfig()
  }, [running, refreshConfig])

  const getApiKey = useCallback(async (): Promise<string> => {
    const cfg = (await window.api.codeCli.apiGateway.getConfig()) as GatewayConfig
    if (!cfg?.apiKey) {
      throw new Error('API gateway did not provide a key')
    }
    return cfg.apiKey
  }, [])

  return useMemo(() => {
    const baseUrl = gatewayClientOrigin(host, port)
    // fork 缝②：端点键为 fork providerView 的 EndpointType 字面量（与 V2 ENDPOINT_TYPE 同值）。
    const provider: Provider = {
      id: CLI_API_GATEWAY_PROVIDER_ID,
      // Display-only; the CLI provider key is decoupled from this title (see cliProviderKeyName).
      name: t('code.api_gateway.title'),
      endpointConfigs: {
        'anthropic-messages': { baseUrl },
        'openai-chat-completions': { baseUrl },
        'openai-responses': { baseUrl }
      },
      apiKeys: [{ id: 'gateway', key: apiKey ?? '', isEnabled: true }],
      models: []
    }
    return { provider, apiKey, ensureRunning, getApiKey }
  }, [host, port, apiKey, t, ensureRunning, getApiKey])
}
