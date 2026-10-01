import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Model } from '@renderer/types'
import { SystemProviderIds } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'
import {
  isAzureOpenAIProvider,
  isGeminiProvider,
  isNewApiProvider,
  isOpenAICompatibleProvider,
  isOpenAIProvider,
  isVertexProvider
} from '@renderer/utils/provider'

export { GEMINI_FLASH_MODEL_REGEX } from './utils'

import { isEmbeddingModel, isRerankModel } from './embedding'
import { isClaude4SeriesModel } from './reasoning'
import { isAnthropicModel } from './utils'
import { isTextToImageModel } from './vision'

const CLAUDE_SUPPORTED_WEBSEARCH_REGEX = new RegExp(
  `\\b(?:claude-3(-|\\.)(7|5)-sonnet(?:-[\\w-]+)|claude-3(-|\\.)5-haiku(?:-[\\w-]+)|claude-(haiku|sonnet|opus)-4(?:-[\\w-]+)?)\\b`,
  'i'
)

// r2-83：唯一的图片护栏原本是字面量 `-image-preview`，而现行生图 id 是 `-image`
// 与 `-preview-image-generation`（`vision.ts:125-126`、`tooluse.ts:57-58` 都把它们当生图/非函数调用模型），
// 于是 `gemini-2.5-flash-image` / `gemini-2.0-flash-preview-image-generation` 命中本正则而被标成可联网。
// 现在 2.x 与 3.x 两个分支都排除 `-image`（`\b` 以免误伤 `imagen`）；
// `gemini-3-pro-image-preview` / `gemini-3-flash-image-preview` 同理不再匹配。
export const GEMINI_SEARCH_REGEX = new RegExp(
  'gemini-(?:(?!.*-image\\b)2.*(?:-latest)?|3(?:\\.\\d+)?-(?:flash|pro)(?!.*-image\\b)(?:-(?:image-)?preview)?|flash-latest|pro-latest|flash-lite-latest)(?:-[\\w-]+)*$',
  'i'
)

export const PERPLEXITY_SEARCH_MODELS = [
  'sonar-pro',
  'sonar',
  'sonar-reasoning',
  'sonar-reasoning-pro',
  'sonar-deep-research'
]

/**
 * 三值契约（家规 §9 / 不变式 6）：
 * - `true` / `false` = **确定**答案（能 / 不能联网）；
 * - `undefined` = 「还不知道」——provider 尚未可知，调用方**必须稍后重试**，
 *   且**不得**据此写回任何持久化开关（`assistant.enableWebSearch`）。
 *
 * r2-80：此前 provider 查不到就 `return false`。冷启动时 redux-persist 还没回填，`providers`
 * 为空 ⇒ 启动窗口内一律得到「确定不支持」，调用方把 `false` 写进 `assistant.enableWebSearch`
 * 落盘，用户开关被静默关掉。
 *
 * r2-42：`getProviderByModel` 已改为三值契约——查不到返回 `undefined`，不再静默回落到
 * `defaultProvider || providers[0]`。下面 `!provider` 分支就是本调用点的显式处理：
 * 「provider 未知」⇒ 返回 `undefined`，绝不折成确定性的 `false`。
 */
export function isWebSearchModel(model: Model): boolean | undefined {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) {
    return false
  }

  if (isUserSelectedModelType(model, 'web_search') !== undefined) {
    return isUserSelectedModelType(model, 'web_search')!
  }

  const provider = getProviderByModel(model)

  if (!provider) {
    // 未知 provider：不是「不支持」，是「还不知道」。绝不返回 false。
    return undefined
  }

  const modelId = getLowerBaseModelName(model.id, '/')

  if (isAnthropicModel(model)) {
    if (isVertexProvider(provider)) {
      return isClaude4SeriesModel(model)
    }
    return CLAUDE_SUPPORTED_WEBSEARCH_REGEX.test(modelId)
  }

  // TODO: 当其他供应商采用Response端点时，这个地方逻辑需要改进
  // azure现在也支持了websearch
  if (isOpenAIProvider(provider) || isAzureOpenAIProvider(provider)) {
    if (isOpenAIWebSearchModel(model)) {
      return true
    }

    // v2
    if (provider.id === SystemProviderIds.grok) {
      return true
    }

    return false
  }

  if (provider.id === SystemProviderIds.perplexity) {
    return PERPLEXITY_SEARCH_MODELS.includes(modelId)
  }

  if (provider.id === SystemProviderIds.aihubmix) {
    // modelId 不以-search结尾
    if (!modelId.endsWith('-search') && GEMINI_SEARCH_REGEX.test(modelId)) {
      return true
    }

    if (isOpenAIWebSearchModel(model)) {
      return true
    }

    return false
  }

  if (isOpenAICompatibleProvider(provider) || isNewApiProvider(provider)) {
    if (GEMINI_SEARCH_REGEX.test(modelId) || isOpenAIWebSearchModel(model)) {
      return true
    }
    return false
  }

  if (isGeminiProvider(provider) || isVertexProvider(provider)) {
    return GEMINI_SEARCH_REGEX.test(modelId)
  }

  if (provider.id === 'hunyuan') {
    return modelId !== 'hunyuan-lite'
  }

  if (provider.id === 'zhipu') {
    return false
  }

  if (provider.id === 'dashscope') {
    const models = ['qwen-turbo', 'qwen-max', 'qwen-plus', 'qwq', 'qwen-flash', 'qwen3-max']
    // matches id like qwen-max-0919, qwen-max-latest
    return models.some((i) => modelId.startsWith(i))
  }

  if (provider.id === 'openrouter') {
    return true
  }

  return false
}

// r2-110：`isOpenAIWebSearchChatCompletionOnlyModel`（判 `gpt-4o(-mini)-search-preview`）经全仓
// 两法确认零生产引用（只被 `config/models/__tests__/utils.test.ts` 的一句 vi.mock 登记），
// 且其判据已被下面的 `isOpenAIWebSearchModel` 完全覆盖。按 §5.1 删除。

export function isOpenAIWebSearchModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)

  return (
    modelId.includes('gpt-4o-search-preview') ||
    modelId.includes('gpt-4o-mini-search-preview') ||
    (modelId.includes('gpt-4.1') && !modelId.includes('gpt-4.1-nano')) ||
    (modelId.includes('gpt-4o') && !modelId.includes('gpt-4o-image')) ||
    modelId.includes('o3') ||
    modelId.includes('o4') ||
    (modelId.includes('gpt-5') && !modelId.includes('chat'))
  )
}
