import { isOpenAIWebSearchChatCompletionOnlyModel } from '@renderer/config/models'
import type { Model } from '@renderer/types'

export function getWebSearchParams(model: Model): Record<string, any> {
  if (model.provider === 'hunyuan') {
    return { enable_enhancement: true, citation: true, search_info: true }
  }

  if (model.provider === 'dashscope') {
    return {
      enable_search: true,
      search_options: {
        forced_search: true
      }
    }
  }

  // https://creator.poe.com/docs/external-applications/openai-compatible-api#using-custom-parameters-with-extra_body
  if (model.provider === 'poe') {
    return {
      extra_body: {
        web_search: true
      }
    }
  }

  if (isOpenAIWebSearchChatCompletionOnlyModel(model)) {
    return {
      web_search_options: {}
    }
  }
  return {}
}
