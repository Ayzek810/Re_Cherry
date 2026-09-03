/**
 * 职责：提供原子化的、无状态的API调用函数
 * dsh 内核替换后：聊天/摘要/生成/健康检查全部走内核，本文件只保留
 * 图像生成（保留功能）、模型列表与 key 轮换等薄封装。
 */
import { loggerService } from '@logger'
import { isEmbeddingModel } from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { getEmbeddingDimensions } from '@renderer/services/embedding'
import type { Assistant, Model, Provider } from '@renderer/types'
import { isSystemProvider } from '@renderer/types'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import type { Message } from '@renderer/types/newMessage'
import { removeSpecialCharactersForTopicName } from '@renderer/utils'
import { getErrorMessage } from '@renderer/utils/error'
import { purifyMarkdownImages } from '@renderer/utils/markdown'
import { findFileBlocks, findImageBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { containsSupportedVariables, replacePromptVariables } from '@renderer/utils/prompt'
import { NOT_SUPPORT_API_KEY_PROVIDER_TYPES, NOT_SUPPORT_API_KEY_PROVIDERS } from '@renderer/utils/provider'
import { isEmpty, takeRight } from 'lodash'

import {
  // getAssistantProvider,
  // getAssistantSettings,
  getDefaultModel,
  getProviderByModel,
  getQuickModel
} from './AssistantService'

const logger = loggerService.withContext('ApiService')

/**
 * 从消息中收集图像（用于图像编辑）
 * 收集用户消息中上传的图像和助手消息中生成的图像
 */
async function collectImagesFromMessages(userMessage: Message, assistantMessage?: Message): Promise<string[]> {
  const images: string[] = []

  // 收集用户消息中的图像
  const userImageBlocks = findImageBlocks(userMessage)
  for (const block of userImageBlocks) {
    if (block.file) {
      const { data } = await window.api.file.base64Image(block.file.name)
      images.push(data)
    }
  }

  // 收集助手消息中的图像（用于继续编辑生成的图像）
  if (assistantMessage) {
    const assistantImageBlocks = findImageBlocks(assistantMessage)
    for (const block of assistantImageBlocks) {
      if (block.file) {
        try {
          const { data } = await window.api.file.base64Image(block.file.name)
          images.push(data)
        } catch (error) {
          logger.error('Failed to load assistant image file, image will be excluded:', {
            fileName: block.file.name,
            error: error as Error
          })
        }
      } else if (block.url) {
        images.push(block.url)
      }
    }
  }

  return images
}

/** OpenAI 兼容图像生成：POST {apiHost}/images/generations。 */
async function generateImages(
  provider: Provider,
  model: string,
  prompt: string,
  imageSize: string,
  batchSize: number
): Promise<string[]> {
  const response = await fetch(`${provider.apiHost}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({ model, prompt, size: imageSize, n: batchSize })
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Image generation failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await response.json()) as { data?: { b64_json?: string; url?: string }[] }
  return (data.data ?? []).map((item) => item.b64_json ?? item.url ?? '').filter(Boolean)
}

/** OpenAI 兼容图像编辑：POST {apiHost}/images/edits（multipart，逐张编辑）。 */
async function editImages(
  provider: Provider,
  model: string,
  prompt: string,
  inputImages: string[],
  imageSize: string
): Promise<string[]> {
  const results: string[] = []
  for (const dataUrl of inputImages) {
    const blob = await (await fetch(dataUrl)).blob()
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('size', imageSize)
    form.append('image', blob, `image.${blob.type.split('/')[1] ?? 'png'}`)
    const response = await fetch(`${provider.apiHost}/images/edits`, {
      method: 'POST',
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      body: form
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Image edit failed (${response.status}): ${detail.slice(0, 200)}`)
    }
    const data = (await response.json()) as { data?: { b64_json?: string; url?: string }[] }
    results.push(...(data.data ?? []).map((item) => item.b64_json ?? item.url ?? '').filter(Boolean))
  }
  return results
}

/**
 * 独立的图像生成函数
 * 专用于 DALL-E、GPT-Image-1 等专用图像生成模型
 * （内核替换后保留此功能，供后续重新挂回聊天流）
 */
export async function fetchImageGeneration({
  messages,
  assistant,
  onChunkReceived
}: {
  messages: Message[]
  assistant: Assistant
  onChunkReceived: (chunk: Chunk) => void
}) {
  const baseProvider = getProviderByModel(assistant.model || getDefaultModel())
  const provider = {
    ...baseProvider,
    apiKey: getRotatedApiKey(baseProvider)
  }

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })
  onChunkReceived({ type: ChunkType.IMAGE_CREATED })

  const startTime = Date.now()

  try {
    const lastUserMessage = messages.findLast((m) => m.role === 'user')
    const lastAssistantMessage = messages.findLast((m) => m.role === 'assistant')

    if (!lastUserMessage) {
      throw new Error('No user message found for image generation.')
    }

    const prompt = getMainTextContent(lastUserMessage)
    const inputImages = await collectImagesFromMessages(lastUserMessage, lastAssistantMessage)
    const imageSize = '1024x1024'
    const batchSize = 1
    const modelId = assistant.model!.id

    let images: string[]
    if (inputImages.length > 0) {
      images = await editImages(provider, modelId, prompt || '', inputImages, imageSize)
    } else {
      images = await generateImages(provider, modelId, prompt || '', imageSize, batchSize)
    }

    // 发送结果 chunks
    const imageType = images[0]?.startsWith('data:') ? 'base64' : 'url'
    onChunkReceived({
      type: ChunkType.IMAGE_COMPLETE,
      image: { type: imageType, images }
    })

    const imageResponse = {
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      metrics: {
        completion_tokens: 0,
        time_first_token_millsec: 0,
        time_completion_millsec: Date.now() - startTime
      }
    }
    onChunkReceived({ type: ChunkType.BLOCK_COMPLETE, response: imageResponse })
    onChunkReceived({ type: ChunkType.LLM_RESPONSE_COMPLETE, response: imageResponse })
  } catch (error) {
    onChunkReceived({ type: ChunkType.ERROR, error: error as Error })
    throw error
  }
}

export async function fetchMessagesSummary({
  messages
}: {
  messages: Message[]
}): Promise<{ text: string | null; error?: string }> {
  let prompt = getStoreSetting('topicNamingPrompt') || i18n.t('prompts.title')
  const model = getQuickModel()

  if (prompt && containsSupportedVariables(prompt)) {
    prompt = await replacePromptVariables(prompt, model.name)
  }

  // 总结上下文总是取最后5条消息
  const contextMessages = takeRight(messages, 5)
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return { text: null, error: i18n.t('error.no_api_key') }
  }

  const conversation = JSON.stringify(
    contextMessages.map((message) => {
      const structredMessage = {
        role: message.role,
        mainText: purifyMarkdownImages(getMainTextContent(message))
      }

      // 让LLM知道消息中包含的文件，但只提供文件名
      const fileBlocks = findFileBlocks(message)
      let fileList: Array<string> = []
      if (fileBlocks.length && fileBlocks.length > 0) {
        fileList = fileBlocks.map((fileBlock) => fileBlock.file.origin_name)
      }
      return {
        ...structredMessage,
        files: fileList.length > 0 ? fileList : undefined
      }
    })
  )

  try {
    // dsh 内核替换：话题命名走内核一次性 completion（无 session 残留）
    const { text } = await window.api.dshComplete({
      provider: provider.id,
      model: model.id,
      system: prompt,
      messages: [{ role: 'user', text: conversation }],
      maxTokens: 128
    })

    const result = removeSpecialCharactersForTopicName(text)
    return result ? { text: result } : { text: null, error: i18n.t('error.no_response') }
  } catch (error: unknown) {
    return { text: null, error: getErrorMessage(error) }
  }
}

export async function fetchGenerate({
  prompt,
  content,
  model
}: {
  prompt: string
  content: string
  model?: Model
}): Promise<string> {
  if (!model) {
    model = getDefaultModel()
  }
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return ''
  }

  try {
    // dsh 内核替换：搜索编排/记忆/错误诊断等一次性生成走内核 completion
    const { text } = await window.api.dshComplete({
      provider: provider.id,
      model: model.id,
      system: prompt,
      messages: [{ role: 'user', text: content }]
    })
    return text || ''
  } catch (error: any) {
    logger.warn('fetchGenerate failed via kernel', error)
    return ''
  }
}

export function hasApiKey(provider: Provider) {
  if (!provider) return false
  if (
    (isSystemProvider(provider) && NOT_SUPPORT_API_KEY_PROVIDERS.includes(provider.id)) ||
    NOT_SUPPORT_API_KEY_PROVIDER_TYPES.includes(provider.type)
  )
    return true
  return !isEmpty(provider.apiKey)
}

/**
 * Get rotated API key for providers that support multiple keys
 * Returns empty string for providers that don't require API keys
 */
export function getRotatedApiKey(provider: Provider): string {
  // Handle providers that don't require API keys
  if (!provider.apiKey || provider.apiKey.trim() === '') {
    return ''
  }

  const keys = provider.apiKey
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)

  if (keys.length === 0) {
    return ''
  }

  const keyName = `provider:${provider.id}:last_used_key`

  // If only one key, return it directly
  if (keys.length === 1) {
    return keys[0]
  }

  const lastUsedKey = window.keyv.get(keyName)
  if (!lastUsedKey) {
    window.keyv.set(keyName, keys[0])
    return keys[0]
  }

  const currentIndex = keys.indexOf(lastUsedKey)

  // Log when the last used key is no longer in the list
  if (currentIndex === -1) {
    logger.debug('Last used API key no longer found in provider keys, falling back to first key', {
      providerId: provider.id,
      lastUsedKey: lastUsedKey.substring(0, 8) + '...' // Only log first 8 chars for security
    })
  }

  const nextIndex = (currentIndex + 1) % keys.length
  const nextKey = keys[nextIndex]
  window.keyv.set(keyName, nextKey)

  return nextKey
}

/**
 * 拉取 provider 模型列表（OpenAI 兼容 /models；不支持的 provider 返回配置中的静态列表）。
 */
export async function fetchModels(provider: Provider): Promise<Model[]> {
  const apiHost = provider.apiHost
  if (!apiHost) {
    return provider.models ?? []
  }
  try {
    const response = await fetch(`${apiHost}/models`, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}
    })
    if (!response.ok) {
      throw new Error(`List models failed (${response.status})`)
    }
    const data = (await response.json()) as { data?: { id: string }[] }
    const models = (data.data ?? []).map((item) => ({
      id: item.id,
      name: item.id,
      provider: provider.id,
      group: 'default'
    }))
    return models.length > 0 ? models : (provider.models ?? [])
  } catch (error) {
    logger.error('Failed to fetch models from provider', {
      providerId: provider.id,
      providerName: provider.name,
      error: error instanceof Error ? error.message : String(error)
    })
    return provider.models ?? []
  }
}

export function checkApiProvider(provider: Provider): void {
  const isExcludedProvider =
    (isSystemProvider(provider) && NOT_SUPPORT_API_KEY_PROVIDERS.includes(provider.id)) ||
    NOT_SUPPORT_API_KEY_PROVIDER_TYPES.includes(provider.type)

  if (!isExcludedProvider) {
    if (!provider.apiKey) {
      window.toast.error(i18n.t('message.error.enter.api.label'))
      throw new Error(i18n.t('message.error.enter.api.label'))
    }
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    window.toast.error(i18n.t('message.error.enter.api.host'))
    throw new Error(i18n.t('message.error.enter.api.host'))
  }

  if (isEmpty(provider.models)) {
    window.toast.error(i18n.t('message.error.enter.model'))
    throw new Error(i18n.t('message.error.enter.model'))
  }
}

/**
 * Validates that a provider/model pair is working by sending a minimal request.
 * @param provider - The provider configuration to test.
 * @param model - The model to use for the validation request (chat or embeddings).
 * @param timeout - Maximum time (ms) to wait for the request to complete. Defaults to 15000 ms.
 * @throws {Error} If the request fails or times out, indicating the API is not usable.
 */
export async function checkApi(provider: Provider, model: Model, timeout = 15000): Promise<void> {
  checkApiProvider(provider)

  if (isEmbeddingModel(model)) {
    logger.info('checkApi: embedding model detected, calling getEmbeddingDimensions', { modelId: model.id })
    const timerPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    await Promise.race([getEmbeddingDimensions(provider, model), timerPromise])
    return
  }

  // dsh 内核替换：健康检查 = 内核一次性 completion 的 'hi' ping
  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
  await Promise.race([
    window.api.dshComplete({
      provider: provider.id,
      model: model.id,
      messages: [{ role: 'user', text: 'hi' }],
      maxTokens: 16
    }),
    timeoutPromise
  ])
}

export async function checkModel(provider: Provider, model: Model, timeout = 15000): Promise<{ latency: number }> {
  const startTime = performance.now()
  await checkApi(provider, model, timeout)
  return { latency: performance.now() - startTime }
}
