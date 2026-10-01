/**
 * 轻量 AI 服务面的非 session 模态（embed/rerank/vision-document/image）：OpenAI 兼容
 * 平面直连，provider 路由解析与 chat 共用一套底座（Dsh_SyncProviders 快照 +
 * ProviderKeyStore 兜底）。
 *
 * embed/rerank/vision-document 仅供主进程内部消费（搜索压缩/知识库检索/文档处理
 * 通道的视觉模型服务商），不开 IPC 通道——无渲染层消费者就不预置通道
 * （generateImages 骨架教训）；image 经 Dsh_LightImage/Dsh_LightImageAbort 暴露给
 * 渲染层（绘画页/生图工具的执行缝）。
 * 异步 poll 型图像厂商（提交后轮询任务）不支持，命中明错。
 */
import { loggerService } from '@logger'
import { providerKeyStore } from '@main/services/ProviderKeyStore'
import {
  buildImageWireBody,
  IMAGE_WIRE_PROFILES,
  imageWireProfileForProvider
} from '@shared/lightLlm/imageGenerationCatalog'
import type { LightImageEditCall, LightImageGenerateCall, LightImageResult } from '@shared/lightLlm/types'
import { UNSUPPORTED_VENDOR_ERROR_PREFIX } from '@shared/lightLlm/types'

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

/**
 * fork 缝：少数 OpenAI 兼容网关的 API 版本段不是 `/v1`（V2 各家 provider 的
 * `baseUrl` 各自携带版本，如智谱 `https://open.bigmodel.cn/api/paas/v4`、火山 Ark
 * `https://ark.cn-beijing.volces.com/api/v3`），`/v1` 去重规则对它们会拼出
 * `/api/paas/v4/v1/images/generations`、`/api/v3/v1/images/generations` 这种无效路径。
 * 按 host 后缀识别并去掉多余的 `/v1`；其余 host 保持 V2 等价行为。
 *
 * 补 `/api/v3`（火山 Ark 的图像接口就是 `{base}/images/generations`，
 * seedream 系列走这里）——此前 doubao 被当作"范围外"拒绝，属于**误杀**。
 * 同一规则由图像平面推广到 chat 形端点（视觉文档解析的
 * `/chat/completions`），故命名从 `imageEndpoint` 收敛为 `compatibleEndpoint`。
 */
const VERSIONED_API_HOST_SUFFIXES = ['/api/paas/v4', '/api/v3']

function compatibleEndpoint(apiHost: string, path: string): string {
  const base = apiHost.replace(/\/+$/, '')
  if (VERSIONED_API_HOST_SUFFIXES.some((suffix) => base.endsWith(suffix))) return `${base}${path}`
  return endpoint(apiHost, path)
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

// ---- embed（知识库嵌入/搜索压缩的执行缝；EmbeddingClient 归位至此） ----

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
  const url = ollama ? `${route.apiHost.replace(/\/+$/, '')}/api/embeddings` : endpoint(route.apiHost, '/embeddings')
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
  const data = (await response.json()) as {
    results?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>
  }
  if (!Array.isArray(data.results)) {
    throw new Error('lightLlm: unexpected rerank response shape')
  }
  const results = data.results
    .filter((item) => typeof item.index === 'number')
    .map((item) => ({
      index: item.index as number,
      score: typeof item.relevance_score === 'number' ? item.relevance_score : ((item.score as number | undefined) ?? 0)
    }))
  results.sort((a, b) => b.score - a.score)
  return { results }
}

// ---- vision document（文档处理通道 vision-model 条目的执行缝；主进程内部消费） ----

/** 页图（base64 不带 data: 前缀；mediaType 与 LightLlmImage 同封闭联合）。 */
export interface LightVisionDocumentImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
}

export interface LightVisionDocumentCall {
  providerId: string
  modelId: string
  /** 转写指令（调用方持有，见 preprocess/vision 的 VISION_DOCUMENT_PROMPT）。 */
  prompt: string
  images: LightVisionDocumentImage[]
  maxTokens?: number
  /** 单次请求超时（缺省 VISION_REQUEST_TIMEOUT_MS）。 */
  timeoutMs?: number
}

/**
 * 单次视觉请求超时（v1）：端点挂死/排队时必须**在有限时间内把话说清楚**。
 * 此前只有通道的 8 分钟总预算——一页慢请求会把整轮拖到预算耗尽，用户看到的是
 * "转两分钟然后一句 fetch failed"（2026-10-01 实机取证：20 页书第一页请求 120s 被对端掐断）。
 */
export const VISION_REQUEST_TIMEOUT_MS = 90_000

/**
 * 视觉请求失败（v1）。`message` 里拼上 undici 丢弃的 cause 链——`fetch failed` 本身不携带
 * 原因，`SocketError: other side closed` / `UND_ERR_*` 这类关键区分信息全在 cause 里。
 * `retriable` 只对**传输层**失败（超时 / 连接被断）为真：HTTP 状态码与响应形状是服务端的
 * 明确答复，重试无意义（与"单页失败即整本拒绝"的裁定一致，传输层失败才允许重试一次）。
 */
export class LightVisionRequestError extends Error {
  readonly retriable: boolean

  constructor(message: string, retriable: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LightVisionRequestError'
    this.retriable = retriable
  }
}

/** 错误链压成一行（最多四层）：`fetch failed <- SocketError: other side closed`。 */
function describeFailureChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name === 'Error' ? current.message : `${current.name}: ${current.message}`)
      current = (current as { cause?: unknown }).cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.length > 0 ? parts.join(' <- ') : String(error)
}

/** 传输层失败（undici 一律 surface 成 `TypeError: fetch failed`，原因在 cause）。 */
function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError
}

/**
 * 视觉文档解析：OpenAI 兼容 `/chat/completions`，多模态 content = 指令文本 + 页图
 * data URL，返回首条 choice 的文本。
 *
 * 定位（用户裁决：视觉模型 = 文档处理子系统的服务商，不是独立系统）：本函数只是
 * 文档处理通道的一个执行缝，与 embed/rerank 同面（主进程内部消费、不开 IPC）。
 * 图不经内核附件仓——页图是**一次请求的中间产物**，调用方用完即弃，不产生可回放
 * 引用的持久字节（比 LightLlmCall.ephemeralImages 更彻底：根本不入仓）。
 * 非 OpenAI 兼容端点的服务商在此如实报错（HTTP 细节上浮），不静默降级。
 */
export async function lightVisionDocument(call: LightVisionDocumentCall, signal?: AbortSignal): Promise<string> {
  assertNonEmptyString(call.providerId, 'providerId')
  assertNonEmptyString(call.modelId, 'modelId')
  assertNonEmptyString(call.prompt, 'prompt')
  if (!Array.isArray(call.images) || call.images.length === 0) {
    throw new Error('lightLlm: invalid vision document images')
  }
  const route = resolveRoute(call.providerId)
  const body = {
    model: call.modelId,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: call.prompt },
          ...call.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mediaType};base64,${image.data}` }
          }))
        ]
      }
    ],
    ...(call.maxTokens !== undefined && call.maxTokens > 0 ? { max_tokens: call.maxTokens } : {})
  }
  const timeoutMs = call.timeoutMs ?? VISION_REQUEST_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`no response within ${timeoutMs}ms`))
  }, timeoutMs)
  // 调用方 signal（预算/暂停）与本次超时合成：任一触发即掐断在途请求。
  const requestSignal =
    signal === undefined ? timeoutController.signal : AbortSignal.any([signal, timeoutController.signal])
  try {
    const response = await fetch(compatibleEndpoint(route.apiHost, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(route) },
      body: JSON.stringify(body),
      signal: requestSignal
    })
    if (!response.ok) {
      throw new LightVisionRequestError(
        `lightLlm: vision document request failed (${response.status}): ${await readErrorDetail(response)}`,
        false
      )
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new LightVisionRequestError('lightLlm: unexpected vision document response shape', false)
    }
    return content
  } catch (error) {
    if (error instanceof LightVisionRequestError) throw error
    const callerAborted = signal?.aborted === true
    const timedOut = timeoutController.signal.aborted
    const suffix = timedOut ? ` (request timed out after ${timeoutMs}ms)` : callerAborted ? ' (cancelled)' : ''
    // 被调用方打断的请求不是"失败"（暂停/预算有自己的语义与日志），retriable=false。
    throw new LightVisionRequestError(
      `lightLlm: vision document request failed: ${describeFailureChain(error)}${suffix}`,
      timedOut || (!callerAborted && isTransportFailure(error)),
      { cause: error }
    )
  } finally {
    clearTimeout(timer)
  }
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

/**
 * 合并调用方 signal 与渲染层 requestId 注册表 signal。
 *
 * 两个来源都必须在场：`exec.signal` 由**内核 agent 回合**持有（回合中止/暂停），
 * `abort` 由 `Dsh_LightImageAbort(requestId)` 命中。旧写法 `signal ?? abort` 在工具路径
 * （`generateImageTool` 总传 `exec.signal`）下**丢弃** abort ⇒ 用户点"停止生成"后请求继续跑、
 * 继续计费，UI 却已显示停止。任一 signal 中止都必须取消在途请求，故取并集而非二选一。
 */
function mergeAbortSignals(signal: AbortSignal | undefined, abort: AbortSignal | undefined): AbortSignal | undefined {
  if (signal === undefined) return abort
  if (abort === undefined) return signal
  return AbortSignal.any([signal, abort])
}

/**
 * 解析本请求要用的 v2 wire profile。缺省（`generate_image` 工具等无目录信息的
 * 调用方）走 `diffusion` 兼容档，只下发 `size`/`n` 两个基础字段；登记在表的
 * provider（openai / openrouter / dmxapi / zhipu / silicon …）按表改名。
 *
 * fork 缝：**未登记的 provider id 也落 `diffusion` 档**——fork 允许用户自建
 * OpenAI 兼容 provider（以前就是 POST `/v1/images/generations`），在入口把它拒掉等于砍掉
 * 用户自己的端点。只有 `OFF_PLANE_VENDOR_IDS`（V2 靠 `vendorTransport` 换端点的厂商）
 * 才走明错，判定统一在 `imageWireProfileForProvider`。
 */
function imageWireProfileFor(call: { provider: string; wireProfileId?: string }) {
  return imageWireProfileForProvider(call.wireProfileId ?? call.provider) ?? IMAGE_WIRE_PROFILES.diffusion
}

/**
 * 请求参数袋 → 扁平 vendor body。
 *
 * fork 缝：V2 在渲染层已按 support 过滤（`buildParamsSchema`），主进程只做
 * `splitParamValues` + profile 改名；fork 在此再按调用方声明的 `supportedParams`
 * 过滤一层——目录是「每个模型真正的参数面」的唯一事实源，主进程不猜。未声明
 * `supportedParams` 的调用方（工具）只放行 profile 自身会映射的键。
 */
function imageParamValues(call: {
  paramValues?: Record<string, unknown>
  supportedParams?: string[]
}): Record<string, unknown> {
  const raw = call.paramValues ?? {}
  const allowed = call.supportedParams
  if (allowed === undefined) return raw
  const allowSet = new Set(allowed)
  return Object.fromEntries(Object.entries(raw).filter(([key]) => allowSet.has(key)))
}

/** 渲染层命中「范围外 provider」的明错（V2 无此路径，fork 缝）。 */
function unsupportedVendor(provider: string, model: string): Error {
  return new Error(
    `${UNSUPPORTED_VENDOR_ERROR_PREFIX}: provider "${provider}" (model "${model}") is not supported by the OpenAI-compatible image plane`
  )
}

/**
 * 图像生成的请求体：`model`/`prompt` 固定，其余全部来自 profile 改名后的参数袋。
 *
 * fork 缝：V2 的 `splitParamValues` + `buildVendorProviderOptions` 是 AI SDK 的
 * providerOptions 分包；fork 的同一平面是**一个扁平 JSON body**，故等价实现为
 * 「catalog `wireName` + profile `forward`/`fields` + native binding（numImages→n、
 * aspectRatio 归一化）」。原 5 键硬编码白名单（size/n/negative_prompt/seed/
 * num_inference_steps/guidance_scale/quality）已删除——它正是"看得见却静默丢弃"
 * 的根源：openrouter 的 aspectRatio/resolution/outputFormat、openai 的
 * background/moderation、zhipu 的 watermark 全部到不了 wire。
 */
function generationBody(call: LightImageGenerateCall): Record<string, unknown> {
  return {
    model: call.model,
    prompt: call.prompt,
    ...buildImageWireBody(imageWireProfileFor(call), imageParamValues(call))
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
  // fork 缝：**明确不在本平面**的厂商走明错（V2 由 registry 的 vendorTransport 决定端点，
  // fork 无该层，故在进入请求前显式拒绝，绝不静默丢参数）；未登记的 provider id（用户自建的
  // OpenAI 兼容 provider）不在此列，按 `diffusion` 兼容档放行。
  if (imageWireProfileForProvider(call.wireProfileId ?? call.provider) === undefined) {
    throw unsupportedVendor(call.provider, call.model)
  }
  const route = resolveRoute(call.provider)
  const abort = beginImageAbort(call.requestId)
  try {
    const response = await fetch(compatibleEndpoint(route.apiHost, '/images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(route) },
      body: JSON.stringify(generationBody(call)),
      signal: mergeAbortSignals(signal, abort)
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
  // 同 `lightGenerateImage`：不在本平面的厂商明错，未登记的 provider id 按兼容档放行。
  if (imageWireProfileForProvider(call.wireProfileId ?? call.provider) === undefined) {
    throw unsupportedVendor(call.provider, call.model)
  }
  const route = resolveRoute(call.provider)
  const abort = beginImageAbort(call.requestId)
  // fork 缝：编辑端点与生成共用同一参数袋 + profile 改名，只多带 image。
  const editBody = buildImageWireBody(imageWireProfileFor(call), imageParamValues(call))
  try {
    const images: string[] = []
    for (const input of call.inputImages) {
      const form = new FormData()
      form.append('model', call.model)
      form.append('prompt', call.prompt)
      for (const [key, value] of Object.entries(editBody)) {
        if (value === undefined || value === null) continue
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
      const blob = imageToBlob(input)
      form.append('image', blob, `image.${blob.type.split('/')[1] ?? 'png'}`)
      const response = await fetch(compatibleEndpoint(route.apiHost, '/images/edits'), {
        method: 'POST',
        headers: authHeaders(route),
        body: form,
        signal: mergeAbortSignals(signal, abort)
      })
      if (!response.ok) {
        throw new Error(`lightLlm: image edit failed (${response.status}): ${await readErrorDetail(response)}`)
      }
      const result = parseImageResponse(
        (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
      )
      images.push(...result.images)
    }
    logger.info('lightLlm image edited', { provider: call.provider, model: call.model, count: images.length })
    const allBase64 = images.length > 0 && images.every((image) => !image.startsWith('http'))
    return { type: allBase64 ? 'base64' : 'url', images }
  } finally {
    endImageAbort(call.requestId)
  }
}
