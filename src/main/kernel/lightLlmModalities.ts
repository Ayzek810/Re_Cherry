/**
 * 轻量 AI 服务面的非 chat 模态（embed/rerank/image）：OpenAI 兼容平面直连，
 * provider 路由解析与 chat 共用一套底座（Dsh_SyncProviders 快照 + ProviderKeyStore 兜底）。
 *
 * embed/rerank 仅供主进程内部消费（搜索压缩/知识库检索），不开 IPC 通道——
 * 无渲染层消费者就不预置通道（generateImages 骨架教训）；image 经
 * Dsh_LightImage/Dsh_LightImageAbort 暴露给渲染层（绘画页/生图工具的执行缝）。
 * 异步 poll 型图像厂商（提交后轮询任务）不支持，命中明错。
 */
import { loggerService } from '@logger'
import { providerKeyStore } from '@main/services/ProviderKeyStore'
import type { LightImageEditCall, LightImageGenerateCall, LightImageResult } from '@shared/lightLlm/types'

const logger = loggerService.withContext('KernelLightLlmModalities')

// ---- provider 路由底座（与 chat 共用 Dsh_SyncProviders 同步点，见 kernel/index.ts） ----

interface ProviderRoute {
  apiHost: string
  apiKey: string
}

const routes = new Map<string, ProviderRoute>()

/** 内核 provider 路由快照整体投影（Dsh_SyncProviders handler 每次同步时调用）。 */
export function setLightLlmProviderRoutes(providers: Array<{ id?: string; apiHost?: string; apiKey?: string }>): void {
  routes.clear()
  for (const provider of providers) {
    if (provider && typeof provider.id === 'string' && provider.id.length > 0) {
      routes.set(provider.id, {
        apiHost: typeof provider.apiHost === 'string' ? provider.apiHost : '',
        apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : ''
      })
    }
  }
}

function resolveRoute(providerId: string): ProviderRoute {
  const synced = routes.get(providerId)
  // 快照缺 key（渲染层未推 / 空串）时兜底 ProviderKeyStore；用 || 而非 ?? ——
  // 空串不是 nullish，用 ?? 会让兜底永不可达（快照带 provider 但 key 为空时反而发无鉴权请求）。
  const apiKey = synced?.apiKey || providerKeyStore.get(providerId) || ''
  const apiHost = synced?.apiHost ?? ''
  if (apiHost.length === 0) {
    throw new Error(`lightLlm: provider "${providerId}" has no apiHost configured`)
  }
  return { apiHost, apiKey }
}

/** OpenAI 兼容端点拼接：/v1 去重（EmbeddingClient 同特判）。 */
function endpoint(apiHost: string, path: string): string {
  const base = apiHost.replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}${path}` : `${base}/v1${path}`
}

function authHeaders(route: ProviderRoute): Record<string, string> {
  return route.apiKey.length > 0 ? { Authorization: `Bearer ${route.apiKey}` } : {}
}

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`lightLlm: invalid ${name}`)
  }
  return value
}

async function readErrorDetail(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 300)
}

// ---- embed（知识库嵌入/搜索压缩的执行缝；批次2 EmbeddingClient 归位至此） ----

export interface LightEmbedRef {
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

/** 批量嵌入（返回与输入同序的归一化向量）。任一批失败整批抛错（由调用方重试）。 */
export async function lightEmbed(ref: LightEmbedRef, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const route = resolveRoute(ref.providerId)
  const ollama = ref.providerId.startsWith('ollama')
  const url = ollama
    ? `${route.apiHost.replace(/\/+$/, '')}/api/embeddings`
    : endpoint(route.apiHost, '/embeddings')
  const headers = { 'Content-Type': 'application/json', ...authHeaders(route) }

  const results: number[][] = []
  // 批量上限：openai-compatible 单请求多 input；ollama 单请求单 input。
  const batchSize = ollama ? 1 : 16
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize)
    const body = ollama
      ? { model: ref.modelId, prompt: batch[0] }
      : { model: ref.modelId, input: batch, ...(ref.dimensions !== undefined ? { dimensions: ref.dimensions } : {}) }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    if (!response.ok) {
      throw new Error(`lightLlm: embedding request failed (${response.status}): ${await readErrorDetail(response)}`)
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
      throw new Error('lightLlm: unexpected embedding response shape')
    }
  }
  if (results.length !== inputs.length) {
    throw new Error(`lightLlm: embedding count mismatch (${results.length} != ${inputs.length})`)
  }
  return results
}

// ---- rerank（Jina 兼容 /rerank 形状；搜索压缩与知识库检索的重排缝） ----

export interface LightRerankCall {
  providerId: string
  modelId: string
  query: string
  documents: string[]
}

export interface LightRerankResult {
  /** 按相关性降序；index 指向入参 documents 的原始下标。 */
  results: Array<{ index: number; score: number }>
}

/** 重排：query + documents → 相关性降序的 {index, score} 列表。 */
export async function lightRerank(call: LightRerankCall, signal?: AbortSignal): Promise<LightRerankResult> {
  assertNonEmptyString(call.providerId, 'providerId')
  assertNonEmptyString(call.modelId, 'modelId')
  assertNonEmptyString(call.query, 'query')
  if (!Array.isArray(call.documents) || call.documents.length === 0) {
    return { results: [] }
  }
  const route = resolveRoute(call.providerId)
  const response = await fetch(endpoint(route.apiHost, '/rerank'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(route) },
    body: JSON.stringify({ model: call.modelId, query: call.query, documents: call.documents }),
    signal
  })
  if (!response.ok) {
    throw new Error(`lightLlm: rerank request failed (${response.status}): ${await readErrorDetail(response)}`)
  }
  const data = (await response.json()) as { results?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }> }
  if (!Array.isArray(data.results)) {
    throw new Error('lightLlm: unexpected rerank response shape')
  }
  const results = data.results
    .filter((item) => typeof item.index === 'number')
    .map((item) => ({
      index: item.index as number,
      score: typeof item.relevance_score === 'number' ? item.relevance_score : (item.score as number | undefined) ?? 0
    }))
  results.sort((a, b) => b.score - a.score)
  return { results }
}

// ---- image（绘画页 / generate_image 工具的执行缝；OpenAI 兼容平面直连） ----

/** 渲染层取消注册表：requestId → AbortController（Dsh_LightImageAbort 命中）。 */
const imageAborts = new Map<string, AbortController>()

function beginImageAbort(requestId: string | undefined): AbortSignal | undefined {
  if (requestId === undefined || requestId.length === 0) return undefined
  const controller = new AbortController()
  imageAborts.set(requestId, controller)
  return controller.signal
}

function endImageAbort(requestId: string | undefined): void {
  if (requestId !== undefined && requestId.length > 0) imageAborts.delete(requestId)
}

/** 渲染层取消入口（Dsh_LightImageAbort handler 薄转发）。 */
export function abortLightImage(requestId: string): void {
  imageAborts.get(requestId)?.abort()
}

/** 透传参数族 camel→snake（未设置的字段不下发）。 */
function generationBody(call: LightImageGenerateCall): Record<string, unknown> {
  return {
    model: call.model,
    prompt: call.prompt,
    size: call.imageSize,
    n: call.batchSize,
    ...(call.negativePrompt !== undefined ? { negative_prompt: call.negativePrompt } : {}),
    ...(call.seed !== undefined ? { seed: call.seed } : {}),
    ...(call.numInferenceSteps !== undefined ? { num_inference_steps: call.numInferenceSteps } : {}),
    ...(call.guidanceScale !== undefined ? { guidance_scale: call.guidanceScale } : {}),
    ...(call.quality !== undefined ? { quality: call.quality } : {})
  }
}

function parseImageResponse(data: { data?: Array<{ b64_json?: string; url?: string }> }): LightImageResult {
  const images = (data.data ?? []).map((item) => item.b64_json ?? item.url ?? '').filter(Boolean)
  const allBase64 = images.length > 0 && images.every((image) => !image.startsWith('http'))
  return { type: allBase64 ? 'base64' : 'url', images }
}

/** 图像生成：POST /images/generations（同步返回；异步 poll 型厂商不支持）。 */
export async function lightGenerateImage(
  call: LightImageGenerateCall,
  signal?: AbortSignal
): Promise<LightImageResult> {
  assertNonEmptyString(call.provider, 'provider')
  assertNonEmptyString(call.model, 'model')
  assertNonEmptyString(call.prompt, 'prompt')
  assertNonEmptyString(call.imageSize, 'imageSize')
  if (typeof call.batchSize !== 'number' || call.batchSize < 1 || call.batchSize > 8) {
    throw new Error('lightLlm: invalid batchSize')
  }
  const route = resolveRoute(call.provider)
  const abort = beginImageAbort(call.requestId)
  try {
    const response = await fetch(endpoint(route.apiHost, '/images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(route) },
      body: JSON.stringify(generationBody(call)),
      signal: signal ?? abort
    })
    if (!response.ok) {
      throw new Error(`lightLlm: image generation failed (${response.status}): ${await readErrorDetail(response)}`)
    }
    const result = parseImageResponse((await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> })
    logger.info('lightLlm image generated', { provider: call.provider, model: call.model, count: result.images.length })
    return result
  } finally {
    endImageAbort(call.requestId)
  }
}

/** data URL 或裸 base64 → Blob（multipart 编辑用；裸 base64 按 png 处理）。 */
function imageToBlob(source: string): Blob {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(source)
  if (match !== null) {
    return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] })
  }
  return new Blob([Buffer.from(source, 'base64')], { type: 'image/png' })
}

/** 图像编辑：逐张 multipart /images/edits（OpenAI 兼容平面）。 */
export async function lightEditImage(call: LightImageEditCall, signal?: AbortSignal): Promise<LightImageResult> {
  assertNonEmptyString(call.provider, 'provider')
  assertNonEmptyString(call.model, 'model')
  assertNonEmptyString(call.prompt, 'prompt')
  if (!Array.isArray(call.inputImages) || call.inputImages.length === 0) {
    throw new Error('lightLlm: invalid inputImages')
  }
  const route = resolveRoute(call.provider)
  const abort = beginImageAbort(call.requestId)
  try {
    const images: string[] = []
    for (const input of call.inputImages) {
      const form = new FormData()
      form.append('model', call.model)
      form.append('prompt', call.prompt)
      if (call.imageSize !== undefined) form.append('size', call.imageSize)
      const blob = imageToBlob(input)
      form.append('image', blob, `image.${blob.type.split('/')[1] ?? 'png'}`)
      const response = await fetch(endpoint(route.apiHost, '/images/edits'), {
        method: 'POST',
        headers: authHeaders(route),
        body: form,
        signal: signal ?? abort
      })
      if (!response.ok) {
        throw new Error(`lightLlm: image edit failed (${response.status}): ${await readErrorDetail(response)}`)
      }
      const result = parseImageResponse((await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> })
      images.push(...result.images)
    }
    logger.info('lightLlm image edited', { provider: call.provider, model: call.model, count: images.length })
    const allBase64 = images.length > 0 && images.every((image) => !image.startsWith('http'))
    return { type: allBase64 ? 'base64' : 'url', images }
  } finally {
    endImageAbort(call.requestId)
  }
}
