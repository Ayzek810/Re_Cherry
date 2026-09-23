import type { Model } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'
import { getImageGenerationCatalogEntry } from '@shared/lightLlm/imageGenerationCatalog'

import { isEmbeddingModel, isRerankModel } from './embedding'

// Vision models
const visionAllowedModels = [
  'llava',
  'moondream',
  'minicpm',
  'gemini-1\\.5',
  'gemini-2\\.0',
  'gemini-2\\.5',
  'gemini-3(?:\\.\\d)?-(?:flash|pro)(?:-preview)?',
  'gemini-(flash|pro|flash-lite)-latest',
  'gemini-exp',
  'claude-3',
  'claude-haiku-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'vision',
  'glm-4(?:\\.\\d+)?v(?:-[\\w-]+)?',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'qwen3\\.[5-9](?!-max)(?:-[\\w-]+)?',
  'qwen2.5-omni',
  'qwen3-omni(?:-[\\w-]+)?',
  'qvq',
  'internvl2',
  'grok-vision-beta',
  'grok-4(?:-[\\w-]+)?',
  'grok-build(?:-[\\w-]+)?',
  'pixtral',
  'gpt-4(?:-[\\w-]+)',
  'gpt-4.1(?:-[\\w-]+)?',
  'gpt-4o(?:-[\\w-]+)?',
  'gpt-4.5(?:-[\\w-]+)',
  'gpt-5(?:-[\\w-]+)?',
  'chatgpt-4o(?:-[\\w-]+)?',
  'o1(?:-[\\w-]+)?',
  'o3(?:-[\\w-]+)?',
  'o4(?:-[\\w-]+)?',
  'deepseek-vl(?:[\\w-]+)?',
  'kimi-k2\\.[56](?:-[\\w-]+)?',
  'kimi-latest',
  'gemma-?[3-4](?:[-.\\w]+)?',
  'doubao-seed-1[.-][68](?:-[\\w-]+)?',
  'doubao-seed-2[.-]0(?:-[\\w-]+)?',
  'doubao-seed-code(?:-[\\w-]+)?',
  'minimax-m3(?:-[\\w-]+)?',
  'kimi-thinking-preview',
  `gemma3(?:[-:\\w]+)?`,
  'kimi-vl-a3b-thinking(?:-[\\w-]+)?',
  'llama-guard-4(?:-[\\w-]+)?',
  'llama-4(?:-[\\w-]+)?',
  'step-1o(?:.*vision)?',
  'step-1v(?:-[\\w-]+)?',
  'qwen-omni(?:-[\\w-]+)?',
  'mistral-large-(2512|latest)',
  'mistral-medium-(2508|latest)',
  'mistral-small',
  'mimo-v2\\.5$',
  'mimo-v2-omni(?:-[\\w-]+)?',
  'glm-5v-turbo'
]

const visionExcludedModels = [
  'gpt-4-\\d+-preview',
  'gpt-4-turbo-preview',
  'gpt-4-32k',
  'gpt-4-\\d+',
  'o1-mini',
  'o3-mini',
  'o1-preview',
  'AIDC-AI/Marco-o1'
]
const VISION_REGEX = new RegExp(
  `\\b(?!(?:${visionExcludedModels.join('|')})\\b)(${visionAllowedModels.join('|')})\\b`,
  'i'
)

const STEPFUN_VISION_MODELS = new Set(['step-3.7-flash'])

// All dedicated image generation models (only generate images, no text chat capability)
// These models need:
// 1. Route to dedicated image generation API
// 2. Exclude from reasoning/websearch/tooluse selection
const DEDICATED_IMAGE_MODELS = [
  // OpenAI series
  'dall-e(?:-[\\w-]+)?',
  'gpt-image(?:-[\\w-]+)?',
  // xAI
  'grok-2-image(?:-[\\w-]+)?',
  // Google
  'imagen(?:-[\\w-]+)?',
  // Stable Diffusion series
  'flux(?:-[\\w-]+)?',
  'stable-?diffusion(?:-[\\w-]+)?',
  'stabilityai(?:-[\\w-]+)?',
  'sd-[\\w-]+',
  'sdxl(?:-[\\w-]+)?',
  // zhipu
  'cogview(?:-[\\w-]+)?',
  // Alibaba
  'qwen-image(?:-[\\w-]+)?',
  // Others
  'janus(?:-[\\w-]+)?',
  'midjourney(?:-[\\w-]+)?',
  'mj-[\\w-]+',
  'z-image(?:-[\\w-]+)?',
  'longcat-image(?:-[\\w-]+)?',
  'hunyuanimage(?:-[\\w-]+)?',
  'seedream(?:-[\\w-]+)?',
  'kandinsky(?:-[\\w-]+)?'
]

const IMAGE_ENHANCEMENT_MODELS = [
  'grok-2-image(?:-[\\w-]+)?',
  'qwen-image-edit',
  'gpt-image-1',
  'gpt-image-2',
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3(?:\\.\\d+)?-(?:flash|pro)-image(?:-[\\w-]+)?'
]

const IMAGE_ENHANCEMENT_MODELS_REGEX = new RegExp(IMAGE_ENHANCEMENT_MODELS.join('|'), 'i')

// Models that should auto-enable image generation button when selected（聊天里那个"生图"按钮，
// 与"这模型是不是生图模型"是两件事：它继续用名单，因为那是 UI 的自动开关行为）。
const AUTO_ENABLE_IMAGE_MODELS = [
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-3(?:\\.\\d+)?-(?:flash|pro)-image(?:-[\\w-]+)?',
  ...DEDICATED_IMAGE_MODELS
]

const AUTO_ENABLE_IMAGE_MODELS_REGEX = new RegExp(AUTO_ENABLE_IMAGE_MODELS.join('|'), 'i')

// v0.3.3-18 删除的三份名单（`OPENAI_TOOL_USE_IMAGE_GENERATION_MODELS`、`MODERN_IMAGE_MODELS`、
// `GENERATE_IMAGE_MODELS` 及其正则）：它们曾把 o3/gpt-4o/gpt-4.1*/gpt-5 与 `gemini-*-image`
// 也算进"生图模型"，导致生图判定同时存在多套口径。现在生图判定只读数据
// （`isGenerateImageModel`：用户覆盖 → 端点 → 已移植的 V2 registry 目录），**没有任何名单**。

export const isAutoEnableImageGenerationModel = (model: Model): boolean => {
  if (!model) return false

  const modelId = getLowerBaseModelName(model.id)
  return AUTO_ENABLE_IMAGE_MODELS_REGEX.test(modelId)
}

/**
 * 判断模型是否支持图像生成 —— **生图场景的唯一判据（宽语义）**（v0.3.3-18 收敛）。
 *
 * 依据 V2 的机制（`cherry-studio v2/src/shared/utils/model.ts:45-46`：
 * `isGenerateImageModel = (model) => model.capabilities.includes(MODEL_CAPABILITY.IMAGE_GENERATION)`，
 * 数据由 provider registry 声明，**V2 的判定路径里没有任何 id 名单**），fork 按同样的
 * **数据优先**顺序，且只有这三层：
 *
 *   ① **用户手选覆盖**：`capabilities[{type:'image_generation', isUserSelected}]`，最高优先
 *      （与 vision/reasoning 同一套语义，`utils/index.ts:205`；编辑弹窗那枚「生图」开关写的就是它）。
 *   ② `endpoint_type` / `supported_endpoint_types` 含 `'image-generation'`
 *      （V2 端点机制在 fork 的对应字段；V2 侧由 `endpointImpliedCapability` 反推能力）。
 *   ③ **已移植的 V2 registry 目录命中**（`@shared/lightLlm/imageGenerationCatalog`，
 *      74 条带出处、现已连同 V2 的 `capabilities` 一起带出）。
 *
 * **没有任何 V1 名单兜底**：目录里没有、端点也没声明、用户也没手选的模型，就是"不是生图模型"；
 * 要它进来，用编辑弹窗手选（写 ①）。谁读它：绘画页候选集（`isPaintingCandidateModel`）、
 * `管理模型`的「图片」筛选 tab、对话选单的排除（取反）。
 */
export function isGenerateImageModel(model: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model)) {
    return false
  }

  const userSelected = isUserSelectedModelType(model, 'image_generation')
  if (userSelected !== undefined) {
    return userSelected
  }

  if (model.endpoint_type === 'image-generation' || model.supported_endpoint_types?.includes('image-generation')) {
    return true
  }

  return getImageGenerationCatalogEntry(model.provider, model.id) !== null
}

/**
 * 判断模型是否"**专用 / 文生图**"（窄语义）——「生图」标签就用它。
 *
 * 逐字对齐 V2：`isTextToImageModel = IMAGE_GENERATION && !REASONING`
 * （`cherry-studio v2/src/shared/utils/model.ts:84-86`，V2 注释原话
 * *"Dedicated / text-to-image model = `IMAGE_GENERATION` without `REASONING`"*）。
 * fork 的 `reasoning` 位读**已移植的 registry 目录**（生成器把 V2 的 `capabilities` 原样带出），
 * 不去问 `isReasoningModel`——那个函数自己会被生图判定短路，会污染这条判断。
 *
 * 效果：`dall-e-*` / `gpt-image-*` / `flux-*` / `seedream-*` / `cogview*` / `qwen-image*` 是；
 * registry 里带 `reasoning` 的 `gemini-*-image`、`gpt-5-image` 等**不是**（它们能对话、靠工具出图）。
 */
export function isTextToImageModel(model: Model): boolean {
  if (!isGenerateImageModel(model)) return false
  const entry = getImageGenerationCatalogEntry(model.provider, model.id)
  return entry?.capabilities.includes('reasoning') !== true
}

/**
 * 对话模型候选谓词：凡是"要挑一个**能对话**的模型"的地方都用它。
 *
 * = `!嵌入 && !重排 && !isGenerateImageModel` —— 与生图判据**互为取反**，不另立判据
 * （V2 对应物是 `shared/utils/model.ts:88-96` 的 `isNonChatModel`，那边同样用取反的统一判据
 * 排除生图/视频/音频/嵌入/重排）。要调整"谁能当生图模型"，只改 `isGenerateImageModel` 一处。
 */
export function isChatCandidateModel(model: Model | undefined): boolean {
  if (!model) return false
  if (isEmbeddingModel(model) || isRerankModel(model)) return false
  return !isGenerateImageModel(model)
}

export function isVisionModel(model: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model)) {
    return false
  }
  // 新添字段 copilot-vision-request 后可使用 vision
  // if (model.provider === 'copilot') {
  //   return false
  // }
  if (isUserSelectedModelType(model, 'vision') !== undefined) {
    return isUserSelectedModelType(model, 'vision')!
  }

  const modelId = getLowerBaseModelName(model.id)
  if (model.provider === 'stepfun' && STEPFUN_VISION_MODELS.has(modelId)) {
    return true
  }

  if (model.provider === 'doubao' || modelId.includes('doubao')) {
    return VISION_REGEX.test(model.name) || VISION_REGEX.test(modelId) || false
  }

  return VISION_REGEX.test(modelId) || IMAGE_ENHANCEMENT_MODELS_REGEX.test(modelId) || false
}
