// fork 缝：V2 Model/Provider 类型未整体移植，此处为函数面所需最小结构
// （isNonChatModel / isGatewayRoutableModel 及其直接私有依赖，函数体逐字取自
// V2 src/shared/utils/model.ts）。V2 依赖按原值内联为缝：
// - @cherrystudio/provider-registry 的枚举常量与 endpointImpliedCapability；
// - @shared/data/presets/cherryai 的 isManagedCherryAiDefaultModel；
// - parseUniqueModelId 复用 fork 既有 @shared/types/uniqueModelId（同为按首个
//   '::' 切分；差异：id 无分隔符时 fork 不抛错、V2 抛错）。
// 最小结构的字段名与 V2 Model 一致、能力字段全部可选（fork 消费方 KernelModelInput
// 无 capabilities 等字段），故仅 capabilities 的直接访问加 ?. —— 与 V2 isRerankModel
// 已有的可选能力面同型，逐处标注。
import { parseUniqueModelId, type UniqueModelId } from '@shared/types/uniqueModelId'

/**
 * Model identification and capability check functions.
 *
 * This module has two sections:
 *
 * 1. **Runtime model checks** — query Model schema fields (capabilities, reasoning,
 *    parameterSupport). These are the primary API for callers.
 *
 * 2. **Model-ID utilities** — name normalization (`getLowerBaseModelName`).
 *    Capability inference from raw ids lives in
 *    `@cherrystudio/provider-registry` (creator-declared data).
 */

// fork 缝：枚举常量按 V2 原值内联（V2 packages/provider-registry/src/schemas/enums.ts）。
const ENDPOINT_TYPE = {
  ANTHROPIC_MESSAGES: 'anthropic-messages',
  GOOGLE_GENERATE_CONTENT: 'google-generate-content',
  JINA_RERANK: 'jina-rerank',
  OLLAMA_CHAT: 'ollama-chat',
  OLLAMA_GENERATE: 'ollama-generate',
  OPENAI_AUDIO_TRANSCRIPTION: 'openai-audio-transcription',
  OPENAI_AUDIO_TRANSLATION: 'openai-audio-translation',
  OPENAI_CHAT_COMPLETIONS: 'openai-chat-completions',
  OPENAI_EMBEDDINGS: 'openai-embeddings',
  OPENAI_IMAGE_EDIT: 'openai-image-edit',
  OPENAI_IMAGE_GENERATION: 'openai-image-generation',
  OPENAI_RESPONSES: 'openai-responses',
  OPENAI_TEXT_COMPLETIONS: 'openai-text-completions',
  OPENAI_TEXT_TO_SPEECH: 'openai-text-to-speech',
  OPENAI_VIDEO_GENERATION: 'openai-video-generation'
} as const
type EndpointTypeForGateway = (typeof ENDPOINT_TYPE)[keyof typeof ENDPOINT_TYPE]

const MODEL_CAPABILITY = {
  FUNCTION_CALL: 'function-call',
  REASONING: 'reasoning',
  IMAGE_RECOGNITION: 'image-recognition',
  IMAGE_GENERATION: 'image-generation',
  AUDIO_RECOGNITION: 'audio-recognition',
  AUDIO_GENERATION: 'audio-generation',
  EMBEDDING: 'embedding',
  RERANK: 'rerank',
  AUDIO_TRANSCRIPT: 'audio-transcript',
  VIDEO_RECOGNITION: 'video-recognition',
  VIDEO_GENERATION: 'video-generation',
  STRUCTURED_OUTPUT: 'structured-output',
  FILE_INPUT: 'file-input',
  CODE_EXECUTION: 'code-execution',
  FILE_SEARCH: 'file-search',
  COMPUTER_USE: 'computer-use'
} as const
type ModelCapabilityForGateway = (typeof MODEL_CAPABILITY)[keyof typeof MODEL_CAPABILITY]

const MODALITY = {
  TEXT: 'text',
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  VECTOR: 'vector'
} as const
type ModalityForGateway = (typeof MODALITY)[keyof typeof MODALITY]

// fork 缝：endpointImpliedCapability 按原文搬自 @cherrystudio/provider-registry
// （V2 packages/provider-registry/src/registry-utils.ts）。
const ENDPOINT_IMPLIED_CAPABILITY: Partial<Record<EndpointTypeForGateway, ModelCapabilityForGateway>> = {
  [ENDPOINT_TYPE.JINA_RERANK]: MODEL_CAPABILITY.RERANK,
  [ENDPOINT_TYPE.OPENAI_AUDIO_TRANSCRIPTION]: MODEL_CAPABILITY.AUDIO_TRANSCRIPT,
  [ENDPOINT_TYPE.OPENAI_AUDIO_TRANSLATION]: MODEL_CAPABILITY.AUDIO_TRANSCRIPT,
  [ENDPOINT_TYPE.OPENAI_EMBEDDINGS]: MODEL_CAPABILITY.EMBEDDING,
  [ENDPOINT_TYPE.OPENAI_IMAGE_GENERATION]: MODEL_CAPABILITY.IMAGE_GENERATION,
  [ENDPOINT_TYPE.OPENAI_IMAGE_EDIT]: MODEL_CAPABILITY.IMAGE_GENERATION,
  [ENDPOINT_TYPE.OPENAI_TEXT_TO_SPEECH]: MODEL_CAPABILITY.AUDIO_GENERATION,
  [ENDPOINT_TYPE.OPENAI_VIDEO_GENERATION]: MODEL_CAPABILITY.VIDEO_GENERATION
}

/** Capability implied by a capability-exclusive endpoint, or `undefined` for general-purpose endpoints. */
function endpointImpliedCapability(
  endpointType: EndpointTypeForGateway | undefined | null
): ModelCapabilityForGateway | undefined {
  return endpointType ? ENDPOINT_IMPLIED_CAPABILITY[endpointType] : undefined
}

// fork 缝：isManagedCherryAiDefaultModel 及其常量按 V2 原文内联
// （V2 src/shared/data/presets/cherryai.ts，函数体逐字）。
const CHERRYAI_PROVIDER_ID = 'cherryai'
const CHERRYAI_DEFAULT_MODEL_ID = 'qwen'

function isManagedCherryAiDefaultModel(providerId: string, modelId: string): boolean {
  return providerId === CHERRYAI_PROVIDER_ID && modelId === CHERRYAI_DEFAULT_MODEL_ID
}

// fork 缝：最小结构类型——只含上述函数实际访问的字段，字段名与 V2 Model 一致；
// 能力字段可选（fork 消费方 KernelModelInput 无这些字段，缺省即"无该能力信号"）。
export interface ModelForGateway {
  id: string
  providerId?: string
  apiModelId?: string
  capabilities?: readonly ModelCapabilityForGateway[]
  endpointTypes?: readonly EndpointTypeForGateway[]
  inputModalities?: readonly ModalityForGateway[]
  outputModalities?: readonly ModalityForGateway[]
}

/** Check if model is an embedding model */
// fork 缝：capabilities 在最小结构上可缺省，访问加 ?. ?? false（V2 原文为直接访问）。
export const isEmbeddingModel = (model: ModelForGateway): boolean =>
  model.capabilities?.includes(MODEL_CAPABILITY.EMBEDDING) ?? false

/** Check if model is a reranking model */
export const isRerankModel = (model: { capabilities?: readonly unknown[] | null }): boolean =>
  model.capabilities?.includes(MODEL_CAPABILITY.RERANK) ?? false

/** Check if model supports image generation */
// fork 缝：capabilities 访问加 ?. ?? false（同上）。
export const isGenerateImageModel = (model: ModelForGateway): boolean =>
  model.capabilities?.includes(MODEL_CAPABILITY.IMAGE_GENERATION) ?? false

// fork 缝：capabilities 访问加 ?.（同上）。
export const isGenerateVideoModel = (model: ModelForGateway): boolean =>
  !!model.capabilities?.includes(MODEL_CAPABILITY.VIDEO_GENERATION)

// fork 缝：capabilities 访问加 ?.（同上）。
export const isGenerateAudioModel = (model: ModelForGateway): boolean =>
  !!model.capabilities?.includes(MODEL_CAPABILITY.AUDIO_GENERATION)

// Prefer the explicit AUDIO_TRANSCRIPT capability. Catalogs that only expose
// modalities still identify a dedicated ASR model by audio input + text output
// with no text input. The no-text-input guard keeps multimodal chat LLMs
// (Gemini, GPT-4o, …) selectable.
// fork 缝：capabilities 访问加 ?. ?? false 并加括号（?? 不可与 || 裸混用）；其余逐字。
export const isSpeechToTextModel = (model: ModelForGateway): boolean =>
  (model.capabilities?.includes(MODEL_CAPABILITY.AUDIO_TRANSCRIPT) ?? false) ||
  ((model.capabilities?.includes(MODEL_CAPABILITY.AUDIO_RECOGNITION) ?? false) &&
    model.inputModalities?.includes(MODALITY.AUDIO) === true &&
    !model.inputModalities.includes(MODALITY.TEXT) &&
    model.outputModalities?.includes(MODALITY.TEXT) === true)

// Mirror of `isSpeechToTextModel`: a dedicated text-to-speech model is identified by
// the explicit AUDIO_GENERATION capability only. Producing audio as an *output
// modality* does NOT make a model text-to-speech — multimodal chat LLMs can emit audio
// yet still chat, and keying on the modality wrongly classified them as non-chat.
// fork 缝：capabilities 访问加 ?. ?? false（同上）。
export const isTextToSpeechModel = (model: ModelForGateway): boolean =>
  model.capabilities?.includes(MODEL_CAPABILITY.AUDIO_GENERATION) ?? false

export const isNonChatModel = (model: ModelForGateway): boolean =>
  endpointImpliedCapability(model.endpointTypes?.[0]) != null ||
  isEmbeddingModel(model) ||
  isRerankModel(model) ||
  isGenerateImageModel(model) ||
  isGenerateVideoModel(model) ||
  isGenerateAudioModel(model) ||
  isTextToSpeechModel(model) ||
  isSpeechToTextModel(model)

/**
 * Models the API gateway can route — the single predicate shared by the gateway's
 * `/v1/models` listing and the renderer's gateway model picker, so the CLI can only
 * pick what the gateway will actually serve. Excludes non-chat models (the gateway
 * only proxies chat dialects), the CherryAI managed default (the gateway's own
 * guard), and models of a provider whose id contains ':' — the gateway address
 * ("providerId:apiModelId") splits on the FIRST ':', so such ids cannot round-trip.
 */
// fork 缝：函数体逐字；参数收窄为最小结构 + 必有 providerId / 品牌化 UniqueModelId
// （isNonChatModel 的消费面允许两者缺省，本函数语义要求必有）。
export const isGatewayRoutableModel = (model: ModelForGateway & { providerId: string; id: UniqueModelId }): boolean => {
  if (model.providerId.includes(':') || isNonChatModel(model)) return false
  return !isManagedCherryAiDefaultModel(model.providerId, getRawModelId(model))
}

// ---------------------------------------------------------------------------
// Extract the raw (wire) model ID from a Model
// ---------------------------------------------------------------------------

/**
 * The wire id every id-based predicate must key off. `apiModelId` is optional
 * or empty on the runtime Model, so reading it alone silently misidentifies models whose
 * unique id carries the wire name instead.
 */
// fork 缝：函数体逐字；参数收窄为最小结构 + 品牌化 UniqueModelId（parseUniqueModelId 入参）。
export function getRawModelId(model: ModelForGateway & { id: UniqueModelId }): string {
  return model.apiModelId || parseUniqueModelId(model.id).modelId
}

// ---------------------------------------------------------------------------
// fork 缝：以下三个函数逐字取自 V2 src/shared/utils/model.ts（isGemini3ModelId
// 为 L208-215，getBaseModelName / getLowerBaseModelName 为 L394-417），
// 纯字符串工具、零 V2 独有依赖。入口是 isGemini3ModelId（adapters 的
// AnthropicMessageConverter 消费）；getBaseModelName / getLowerBaseModelName
// 是其直接依赖链，按"含其直接私有依赖"要求一并逐字内联。
// ---------------------------------------------------------------------------

/**
 * Extract the base model name from a model ID.
 * e.g. 'deepseek/deepseek-r1' => 'deepseek-r1'
 */
export const getBaseModelName = (id: string, delimiter: string = '/'): string => {
  const parts = id.split(delimiter)
  return parts[parts.length - 1]
}

/**
 * Extract the base model name and normalize to lowercase.
 * Handles Fireworks version-number normalization and common suffixes.
 */
export const getLowerBaseModelName = (id: string, delimiter: string = '/'): string => {
  const normalizedId = id.toLowerCase().startsWith('accounts/fireworks/models/')
    ? id.replace(/(\d)p(?=\d)/g, '$1.')
    : id

  let baseModelName = getBaseModelName(normalizedId, delimiter).toLowerCase()
  if (baseModelName.endsWith(':free')) baseModelName = baseModelName.replace(':free', '')
  if (baseModelName.endsWith('(free)')) baseModelName = baseModelName.replace('(free)', '')
  if (baseModelName.endsWith(':cloud')) baseModelName = baseModelName.replace(':cloud', '')
  return baseModelName
}

/**
 * Check if a raw model id is Gemini 3 series. The `*-latest` aliases resolve to
 * Gemini 3, so an id-substring check alone misses them.
 */
export const isGemini3ModelId = (modelId: string): boolean => {
  const id = getLowerBaseModelName(modelId)
  return id.includes('gemini-3') || id === 'gemini-flash-latest' || id === 'gemini-pro-latest'
}
