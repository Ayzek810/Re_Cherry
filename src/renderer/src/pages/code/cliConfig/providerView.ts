// fork 缝（批次4a 原创缝模块）：V2 渲染层 CLI 消费的 Provider/Model 宇宙
//（@shared/data/types/provider、@shared/data/types/model）未随 fork 移植——fork 的真源是
// redux `llm.providers`（V1 形状：apiHost/anthropicApiHost/apiKey、models[].supported_endpoint_types，
// 见 @renderer/types）。本模块把 fork 原生形状投影成 V2 CLI 层函数体所需的最小结构
//（endpointConfigs / apiKeys / apiModelId / endpointTypes），使 cliConfig（hermes 路径）与
// code/hooks 的 V2 函数体逐字不动；宇宙换算只发生在本文件。导出类型名与 V2 保持一致
//（Provider/Model/EndpointType），移植文件的 `import type { Provider }` 仅 import 面对号。

import type {
  EndpointType as ForkEndpointType,
  Model as ForkModel,
  ModelType,
  Provider as ForkProvider
} from '@renderer/types'

/** fork 缝：V2 EndpointType 字符串面（@shared/data/types/model.ts ENDPOINT_TYPE 的本层消费子集）。 */
export type EndpointType =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'google-generate-content'

/** fork 缝：V2 @shared/data/types/provider 的 CLI 消费面最小结构（字段名与 V2 一致）。 */
export interface Provider {
  id: string
  name: string
  endpointConfigs?: Partial<Record<EndpointType, { baseUrl?: string }>>
  /** V2 `Provider.apiKeys` 的消费面（key 值由调用方注入——见 useCurrentCliConfigConnection 缝）。 */
  apiKeys?: Array<{ id: string; key: string; isEnabled: boolean }>
  /** V2 注册能力字段；fork provider 无该字段（缺省 ⇒ 非 login-based，同 @shared/utils/provider 缝语义）。 */
  authMethods?: readonly string[]
  /** V2 provider 的默认端点提示；fork provider 无该字段（缺省 ⇒ resolveSupportedEndpointType 跳过该臂）。 */
  defaultChatEndpoint?: EndpointType
  /**
   * fork 缝：raw fork 模型随投影携带（useConfigMetadata 构建 UniqueModelId 键面的原料；
   * V2 经独立模型查询获取，fork 的模型挂在 provider 下）。
   */
  models: ForkModel[]
}

/** fork 缝：V2 @shared/data/types/model 的 CLI 消费面最小结构（字段名与 V2 一致）。 */
export interface Model {
  id: string
  name?: string
  /** wire 模型 id；fork 模型的 `id` 即 wire id（fork 无独立 apiModelId 字段）。 */
  apiModelId?: string
  endpointTypes?: EndpointType[]
  /**
   * fork 缝：V2 Model.capabilities 为 registry 值串（'embedding'/'rerank'/'image-generation'/…）；
   * fork Model.capabilities 为 {type: ModelType} 对象表，投影时按 forkCapabilityToCli 换算。
   * 值面为 @shared/utils/model 判定入参的子集（联合未导出，谓词调用点经 asGatewayModelInput 收窄）。
   */
  capabilities?: readonly CliCapability[]
  /**
   * fork 缝：V2 Model.providerId（必填）；fork 模型的 provider 字段同义，toCliModel 直取。
   */
  providerId: string
}

/** fork 缝：本层投影产出的能力值面（V2 registry 值串中 fork ModelType 可表达的子集）。 */
export type CliCapability =
  | 'embedding'
  | 'rerank'
  | 'image-generation'
  | 'reasoning'
  | 'function-call'
  | 'image-recognition'

// fork 缝：能力类型换算（fork ModelType → V2 registry 值串）。
// fork 'text'/'web_search' 无 registry 对位 → undefined。
function forkCapabilityToCli(type: ModelType): CliCapability | undefined {
  switch (type) {
    case 'embedding':
      return 'embedding'
    case 'rerank':
      return 'rerank'
    case 'image_generation':
      return 'image-generation'
    case 'reasoning':
      return 'reasoning'
    case 'function_calling':
      return 'function-call'
    case 'vision':
      return 'image-recognition'
    default:
      return undefined
  }
}

// fork 缝：端点类型换算（fork EndPointTypeSchema → V2 字符串面）。fork 'gemini'/'image-generation'/
// 'jina-rerank' 不在任何保留工具的端点面内，映射为 undefined（等价"该端点不可用于 CLI"）。
function forkEndpointToCli(type: ForkEndpointType | undefined): EndpointType | undefined {
  switch (type) {
    case 'anthropic':
      return 'anthropic-messages'
    case 'openai':
      return 'openai-chat-completions'
    case 'openai-response':
      return 'openai-responses'
    default:
      return undefined
  }
}

/**
 * fork 缝：fork Provider → V2 形状。apiHost 同时投影到 openai chat/responses 两个端点
 * （fork V1 形状不分端点；openai-response 供应商与 chat 共用 apiHost），anthropicApiHost
 * 投影到 anthropic-messages。authMethods/authOptional 不投影（fork 主进程缝②：无 key 显式
 * 报错，见 DeepSeekHarnessService 缝注）。
 */
export function toCliProvider(provider: ForkProvider): Provider {
  const endpointConfigs: Provider['endpointConfigs'] = {}
  if (provider.apiHost) {
    endpointConfigs['openai-chat-completions'] = { baseUrl: provider.apiHost }
    endpointConfigs['openai-responses'] = { baseUrl: provider.apiHost }
  }
  if (provider.anthropicApiHost) {
    endpointConfigs['anthropic-messages'] = { baseUrl: provider.anthropicApiHost }
  }
  return {
    id: provider.id,
    name: provider.name,
    endpointConfigs,
    apiKeys: [{ id: 'default', key: provider.apiKey ?? '', isEnabled: true }],
    models: provider.models ?? []
  }
}

/** fork 缝：fork Model → V2 形状（apiModelId = fork 模型 id；endpointTypes/capabilities 逐项换算）。 */
export function toCliModel(model: ForkModel): Model {
  const endpointTypes = (model.supported_endpoint_types ?? [])
    .map(forkEndpointToCli)
    .filter((type): type is EndpointType => type !== undefined)
  const capabilities = (model.capabilities ?? [])
    .map((capability) => forkCapabilityToCli(capability.type))
    .filter((capability): capability is CliCapability => capability !== undefined)
  return {
    id: model.id,
    providerId: model.provider,
    name: model.name,
    apiModelId: model.id,
    ...(endpointTypes.length > 0 ? { endpointTypes } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {})
  }
}
