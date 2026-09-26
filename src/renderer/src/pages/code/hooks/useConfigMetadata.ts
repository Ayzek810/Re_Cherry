import { useCallback, useMemo } from 'react'

import { useAppSelector, type RootState } from '@renderer/store'
import { isApiGatewayProviderId, type CodeCli } from '@shared/types/codeCli'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import { isEmbeddingModel, isGenerateImageModel, isGatewayRoutableModel, isRerankModel } from '@shared/utils/model'
import { isLoginBasedProvider } from '@shared/utils/provider'

import { CLI_TOOL_PROVIDER_MAP } from '../constants/cliTools'
import { toCliModel, type Model, type Provider } from '../cliConfig/providerView'
import { isUniqueModelId, safeCreateUniqueModelId } from '../cliConfig/values'
import { parseUniqueModelId } from '@shared/types/uniqueModelId'
import { modelSupportsCliTool } from '../utils/modelSupport'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useConfigMetadata.ts
//（2026-09-24，v0.3.4-1 批次4a）。缝点六处，解析结构（filter/makeModelFilter/resolveProviderMeta
// 的返回形状）逐字：
// ① 模型源缝：V2 useModels({enabled:true}) 全局查询 ← fork providers 自带 models（同步快照，
//   无 loading 态，isModelsLoading 恒 false）；模型以 createUniqueModelId(providerId, modelId)
//   为键进入 modelById/gatewayModelsById（V2 的 Model.id 即 UniqueModelId，本层经
//   safeCreateUniqueModelId 构造同形键）。
// ② 默认模型缝：V2 usePreference('chat.default_model_id')（UniqueModelId 字符串）← fork
//   state.llm.defaultModel（Model 对象），键面同①构造。
// ③ 显示名缝：V2 getProviderDisplayName（registry 别名表）→ fork provider.name。
// ④ claude 臂删除：hasClaudeDetailedModels/getClaudeContextModelId 随 claudeModels.ts 未移植。
// ⑤ provider 过滤缝：fork 输入 providers 已是 enabled 集（useProviders），isEnabled 与
//   isAgentOnlyProvider/isCherryAIProvider（fork 无该注册面）臂不保留；isLoginBasedProvider 逐字。
// ⑥ 能力过滤缝：V2 isTextToImageModel → fork isGenerateImageModel（fork 能力面为
//   image-generation，语义同为"图像生成模型不入 CLI 模型选择"）；三个能力谓词与
//   isGatewayRoutableModel 的入参在 V2 为 registry 联合（未从 @shared/utils/model 导出），
//   经 asGatewayModelInput 按结构收窄（投影值面为其子集）。

// fork 缝⑥（续）：V2 能力谓词与 isGatewayRoutableModel 的入参能力联合未从
// @shared/utils/model 导出；本层投影的能力/端点值面为其子集，经此按结构收窄（无运行时变换）。
const asGatewayModelInput = (model: Model): Parameters<typeof isGatewayRoutableModel>[0] =>
  model as unknown as Parameters<typeof isGatewayRoutableModel>[0]

export function useConfigMetadata(selectedCliTool: CodeCli, providers: Provider[], isProvidersLoading = false) {
  const allModels = useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.models.flatMap((model) => {
          const uniqueModelId = safeCreateUniqueModelId(provider.id, model.id)
          if (!uniqueModelId) return []
          return [{ ...toCliModel(model), id: uniqueModelId, providerId: provider.id } as const]
        })
      ),
    [providers]
  )
  // fork 缝①（续）：V2 经 useModels 全局查询；fork 模型随投影 provider 携带（./providerView 缝），
  // 以 createUniqueModelId(providerId, modelId) 为键（V2 的 Model.id 即 UniqueModelId）。
  // fork 缝②：V2 为 `const [defaultModelId] = usePreference('chat.default_model_id')`。
  const defaultModel = useAppSelector((s: RootState) => s.llm.defaultModel)
  const defaultModelId = defaultModel ? safeCreateUniqueModelId(defaultModel.provider, defaultModel.id) : undefined
  // `gatewayModelsById` is built from both queries, and each yields an empty list while in flight —
  // indistinguishable from "no routable model exists". Expose the combined flag so callers that
  // resolve gateway addresses can wait instead of reading a cold map as an answer.
  const isModelsLoading = false
  const isGatewayModelsLoading = isModelsLoading || isProvidersLoading
  const modelById = useMemo(() => new Map(allModels.map((model) => [model.id, model])), [allModels])
  const gatewayProviderIds = useMemo(
    () =>
      new Set(
        providers
          // fork 缝⑤：V2 为 `(provider) => provider.isEnabled && !isAgentOnlyProvider(provider, getAppEdition())`。
          .filter((provider) => !isLoginBasedProvider(provider))
          .map((provider) => provider.id)
      ),
    [providers]
  )
  const gatewayModelsById = useMemo(
    () =>
      new Map(
        allModels
          .filter((model) => gatewayProviderIds.has(model.providerId) && isGatewayRoutableModel(asGatewayModelInput(model)))
          .map((model) => [model.id, model])
      ),
    [allModels, gatewayProviderIds]
  )
  const defaultGatewayModelId =
    defaultModelId && gatewayModelsById.has(defaultModelId) ? (defaultModelId as Model['id']) : undefined

  const filterProvidersForTool = useCallback((toolId: CodeCli, providers: Provider[]): Provider[] => {
    const filterFn = CLI_TOOL_PROVIDER_MAP[toolId]
    // Exclude login-based providers (Claude Code / Codex OAuth, etc.): they carry no API
    // key/baseUrl to inject into the CLI config, and their "own login" is already surfaced by
    // the synthetic own-login card. `isLoginBasedProvider` keeps api-key-capable mixed providers.
    // fork 缝⑤：V2 另过滤 `p.isEnabled` 与 `isCherryAIProvider(p)`（输入已 enabled、cherryai 未移植）。
    return filterFn ? filterFn(providers).filter((p) => !isLoginBasedProvider(p)) : []
  }, [])
  const filterProviders = useCallback(
    (providers: Provider[]): Provider[] => filterProvidersForTool(selectedCliTool, providers),
    [filterProvidersForTool, selectedCliTool]
  )

  /** Build a model filter scoped to one provider (for the edit panel's picker). */
  const makeModelFilter = useCallback(
    (providerId: string) =>
      (model: Model): boolean => {
        // fork 缝⑥：V2 为 `isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)`。
        const gatewayModel = asGatewayModelInput(model)
        if (isEmbeddingModel(gatewayModel) || isRerankModel(gatewayModel) || isGenerateImageModel(gatewayModel)) {
          return false
        }
        // The gateway does dialect conversion, so any chat model of any enabled provider is usable
        // regardless of the CLI tool — drop the per-tool endpoint gate and the single-provider scope,
        // keeping only what the gateway can route (same predicate as its /v1/models listing).
        if (isApiGatewayProviderId(providerId)) {
          return gatewayProviderIds.has(model.providerId) && isGatewayRoutableModel(gatewayModel)
        }
        if (!modelSupportsCliTool(selectedCliTool, model)) return false
        return model.providerId === providerId
      },
    [gatewayProviderIds, selectedCliTool]
  )

  const resolveProviderMetaForTool = useCallback(
    // fork 缝④（续）：toolId 形参保形（claude 臂删除后不再消费）；config 同（V2 读入
    // detailed-models 判定，保留工具无该面）。
    (_toolId: CodeCli, provider: Provider, providerConfig?: CliProviderConfig) => {
      // fork 缝④：V2 此处先判 Claude detailed models（claudeModels，未移植）再回落
      // providerConfig?.modelId；保留工具无该面，直接读 modelId。
      const modelId = providerConfig?.modelId
      let modelName: string | undefined
      if (modelId && isUniqueModelId(modelId)) {
        const model = modelById.get(modelId)
        const { modelId: rawId } = parseUniqueModelId(modelId)
        modelName = model?.name || rawId
      }
      // fork 缝③：V2 为 `providerName: getProviderDisplayName(provider)`。
      return {
        providerName: provider.name,
        modelName
      }
    },
    [modelById]
  )

  const resolveProviderMeta = useCallback(
    (provider: Provider, providerConfig?: CliProviderConfig) =>
      resolveProviderMetaForTool(selectedCliTool, provider, providerConfig),
    [resolveProviderMetaForTool, selectedCliTool]
  )

  return {
    filterProviders,
    filterProvidersForTool,
    makeModelFilter,
    resolveProviderMeta,
    resolveProviderMetaForTool,
    gatewayModelsById,
    modelById,
    defaultGatewayModelId,
    isGatewayModelsLoading
  }
}
