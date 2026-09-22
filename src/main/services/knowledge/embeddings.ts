/**
 * 知识库嵌入客户端（批次4）：openai-compatible /v1/embeddings 与 ollama /api/embeddings 两路。
 *
 * fork 偏离（相对上游 EmbeddingsFactory）：主进程自取密钥——渲染层只上行
 * {providerId, modelId, dimensions}，apiHost/apiKey 从内核 provider 路由快照
 *（KnowledgeService.setProviders，Dsh_SyncProviders 同一载荷）解析，apiKey 兜底
 * ProviderKeyStore 解密。密钥不回渲染层、不进会话日志（webSearch 同先例）。
 */
import { createHash } from 'node:crypto'

import { loggerService } from '@logger'
import { providerKeyStore } from '@main/services/ProviderKeyStore'

const logger = loggerService.withContext('KnowledgeEmbeddings')

export interface EmbeddingRoute {
  apiHost: string
  apiKey: string
}

export interface EmbeddingModelRef {
  providerId: string
  modelId: string
  dimensions?: number
}

/** 归一化向量（模长 1；零向量原样返回，cosineSimilarity 对零向量返回 0）。 */
export function normalizeVector(vector: number[]): number[] {
  let norm = 0
  for (const value of vector) norm += value * value
  if (norm === 0) return vector
  const scale = 1 / Math.sqrt(norm)
  return vector.map((value) => value * scale)
}

export class EmbeddingClient {
  private readonly routes = new Map<string, EmbeddingRoute>()

  /** 内核 provider 路由快照（Dsh_SyncProviders 载荷）整体投影。 */
  setProviders(providers: Array<{ id?: string; apiHost?: string; apiKey?: string }>): void {
    this.routes.clear()
    for (const provider of providers) {
      if (provider && typeof provider.id === 'string' && provider.id.length > 0) {
        this.routes.set(provider.id, {
          apiHost: typeof provider.apiHost === 'string' ? provider.apiHost : '',
          apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : ''
        })
      }
    }
    logger.info(`knowledge: synced ${this.routes.size} provider route(s) for embeddings`)
  }

  private resolveRoute(ref: EmbeddingModelRef): EmbeddingRoute {
    const synced = this.routes.get(ref.providerId)
    const apiKey = synced?.apiKey ?? providerKeyStore.get(ref.providerId) ?? ''
    const apiHost = synced?.apiHost ?? ''
    return { apiHost, apiKey }
  }

  private endpoint(apiHost: string, ollama: boolean): string {
    const base = apiHost.replace(/\/+$/, '')
    if (ollama) return `${base}/api/embeddings`
    // openai-compatible：/v1 去重（上游 EmbeddingsFactory 同特判）
    return base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`
  }

  /** 批量嵌入（返回与输入同序的归一化向量）。任一批失败整批抛错（由调用方重试）。 */
  async embed(ref: EmbeddingModelRef, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const route = this.resolveRoute(ref)
    if (route.apiHost.length === 0) {
      throw new Error(`knowledge: embedding provider "${ref.providerId}" has no apiHost configured`)
    }
    const ollama = ref.providerId.startsWith('ollama')
    const endpoint = this.endpoint(route.apiHost, ollama)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (!ollama && route.apiKey.length > 0) headers.Authorization = `Bearer ${route.apiKey}`

    const results: number[][] = []
    // 批量上限：openai-compatible 单请求多 input；ollama 单请求单 input。
    const batchSize = ollama ? 1 : 16
    for (let start = 0; start < inputs.length; start += batchSize) {
      const batch = inputs.slice(start, start + batchSize)
      const body = ollama
        ? { model: ref.modelId, prompt: batch[0] }
        : { model: ref.modelId, input: batch, ...(ref.dimensions !== undefined ? { dimensions: ref.dimensions } : {}) }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`knowledge: embedding request failed (${response.status}): ${text.slice(0, 300)}`)
      }
      const data = (await response.json()) as {
        embeddings?: number[][]
        embedding?: number[]
        data?: Array<{ embedding: number[] }>
      }
      if (Array.isArray(data.embedding)) {
        results.push(normalizeVector(data.embedding))
      } else if (Array.isArray(data.data)) {
        for (const item of data.data) results.push(normalizeVector(item.embedding))
      } else if (Array.isArray(data.embeddings)) {
        for (const embedding of data.embeddings) results.push(normalizeVector(embedding))
      } else {
        throw new Error('knowledge: unexpected embedding response shape')
      }
    }
    if (results.length !== inputs.length) {
      throw new Error(`knowledge: embedding count mismatch (${results.length} != ${inputs.length})`)
    }
    return results
  }

  /** 嵌入模型标识（缓存键/日志用，不回渲染层）。 */
  static routeKey(ref: EmbeddingModelRef): string {
    return createHash('sha1')
      .update(`${ref.providerId}\u0000${ref.modelId}\u0000${ref.dimensions ?? ''}`)
      .digest('hex')
      .slice(0, 12)
  }
}
