import { loggerService } from '@logger'
import type { Model, Provider } from '@renderer/types'

const logger = loggerService.withContext('Embedding')

/**
 * 通过 OpenAI 兼容的 /embeddings 端点获取嵌入维度（从 aiCore 迁移，纯 fetch 实现）。
 * 非 OpenAI 兼容的 provider（gemini/vertex/bedrock 等）不保证可用，失败抛错由调用方处理。
 */
export async function getEmbeddingDimensions(provider: Provider, model: Model): Promise<number> {
  const url = `${provider.apiHost}/embeddings`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({ model: model.id, input: ['test'] })
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Embedding request failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await response.json()) as { data?: { embedding?: number[] }[] }
  const dimension = data?.data?.[0]?.embedding?.length
  if (dimension === undefined || dimension === 0) {
    throw new Error('Embedding response has no embedding vector')
  }
  logger.debug('embedding dimension resolved', { model: model.id, dimension })
  return dimension
}
