/**
 * 轻量 AI 服务面非 chat 模态机测：路由解析（快照 + KeyStore 兜底 + 无 host 明错）、
 * embed 两协议形状与批量语义、rerank 请求/响应形状与排序、image 生成/编辑的
 * 参数透传、取消注册表与响应归一。fetch 全 mock（node fetch 语义）。
 */
import { providerKeyStore } from '@main/services/ProviderKeyStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  abortLightImage,
  lightEditImage,
  lightEmbed,
  lightGenerateImage,
  lightRerank,
  normalizeVector,
  setLightLlmProviderRoutes
} from '../lightLlmModalities'

vi.mock('@main/services/ProviderKeyStore', () => ({
  providerKeyStore: { get: vi.fn(() => undefined) }
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as unknown as Response

const errorResponse = (status: number, text: string): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text
  }) as unknown as Response

beforeEach(() => {
  fetchMock.mockReset()
  vi.mocked(providerKeyStore.get).mockReturnValue(undefined)
  setLightLlmProviderRoutes([{ id: 'silicon', apiHost: 'https://api.siliconflow.cn/v1', apiKey: 'sk-test' }])
})

afterEach(() => {
  setLightLlmProviderRoutes([])
})

describe('路由解析', () => {
  it('快照命中：apiHost/apiKey 取快照；/v1 去重拼接端点', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ embedding: [1, 0] }] }))
    await lightEmbed({ providerId: 'silicon', modelId: 'm' }, ['x'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/embeddings')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('快照内 apiKey 为空时兜底 ProviderKeyStore；无 apiHost 明错', async () => {
    vi.mocked(providerKeyStore.get).mockReturnValue('sk-fallback')
    setLightLlmProviderRoutes([{ id: 'other', apiHost: 'https://p.example.com', apiKey: '' }])
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ embedding: [1, 0] }] }))
    await lightEmbed({ providerId: 'other', modelId: 'm' }, ['x'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://p.example.com/v1/embeddings')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-fallback')

    // apiHost 只来自 provider 快照（KeyStore 只兜 key）→ 快照里没有的 provider 明错，不静默降级。
    await expect(lightEmbed({ providerId: 'nobody', modelId: 'm' }, ['x'])).rejects.toThrow('no apiHost configured')
  })
})

describe('lightEmbed', () => {
  it('openai 兼容：批量 input + dimensions 透传；data[].embedding 归一化', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ data: [{ embedding: [3, 4] }, { embedding: [0, 0] }, { embedding: [1, 0] }] })
    )
    const vectors = await lightEmbed({ providerId: 'silicon', modelId: 'm', dimensions: 768 }, ['a', 'b', 'c'])
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ model: 'm', input: ['a', 'b', 'c'], dimensions: 768 })
    expect(vectors).toEqual([normalizeVector([3, 4]), normalizeVector([0, 0]), normalizeVector([1, 0])])
    // 归一化按 1/模长 缩放，末位有 1 ULP 误差 → 断言近似而非字面相等。
    expect(vectors[0]?.[0]).toBeCloseTo(0.6, 12)
    expect(vectors[0]?.[1]).toBeCloseTo(0.8, 12)
  })

  it('返回条数与输入不符：明错，不静默补零', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [{ embedding: [3, 4] }, { embedding: [0, 0] }] }))
    await expect(lightEmbed({ providerId: 'silicon', modelId: 'm' }, ['a', 'b', 'c'])).rejects.toThrow(
      'embedding count mismatch'
    )
  })

  it('ollama：/api/embeddings 端点、单条 prompt、embedding 单数形状', async () => {
    setLightLlmProviderRoutes([{ id: 'ollama-local', apiHost: 'http://127.0.0.1:11434', apiKey: '' }])
    fetchMock.mockResolvedValue(okResponse({ embedding: [1, 1] }))
    const vectors = await lightEmbed({ providerId: 'ollama-local', modelId: 'm' }, ['a', 'b'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/embeddings')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'm', prompt: 'a' })
    expect(vectors).toEqual([normalizeVector([1, 1]), normalizeVector([1, 1])])
  })

  it('HTTP 错误带状态码与截断响应体；畸形响应形状明错', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429, 'rate limited'))
    await expect(lightEmbed({ providerId: 'silicon', modelId: 'm' }, ['x'])).rejects.toThrow(
      'embedding request failed (429): rate limited'
    )
    fetchMock.mockResolvedValueOnce(okResponse({ unexpected: true }))
    await expect(lightEmbed({ providerId: 'silicon', modelId: 'm' }, ['x'])).rejects.toThrow(
      'unexpected embedding response shape'
    )
  })
})

describe('lightRerank', () => {
  it('POST /rerank（model/query/documents）；relevance_score 降序排列', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 }
        ]
      })
    )
    const result = await lightRerank({
      providerId: 'silicon',
      modelId: 'rerank-m',
      query: 'q',
      documents: ['a', 'b', 'c']
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/rerank')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'rerank-m', query: 'q', documents: ['a', 'b', 'c'] })
    expect(result.results).toEqual([
      { index: 2, score: 0.9 },
      { index: 0, score: 0.5 }
    ])
  })

  it('score 兼容字段兜底；空 documents 直接空结果不发请求', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ results: [{ index: 0, score: 0.3 }] }))
    const result = await lightRerank({ providerId: 'silicon', modelId: 'm', query: 'q', documents: ['a'] })
    expect(result.results).toEqual([{ index: 0, score: 0.3 }])

    const empty = await lightRerank({ providerId: 'silicon', modelId: 'm', query: 'q', documents: [] })
    expect(empty.results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 错误明错', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'boom'))
    await expect(lightRerank({ providerId: 'silicon', modelId: 'm', query: 'q', documents: ['a'] })).rejects.toThrow(
      'rerank request failed (500): boom'
    )
  })
})

describe('lightGenerateImage', () => {
  const generate = (overrides: Record<string, unknown> = {}): Promise<unknown> =>
    lightGenerateImage({
      provider: 'silicon',
      model: 'img-model',
      prompt: 'a cat',
      paramValues: { size: '1024x1024', numImages: 1 },
      ...overrides
    } as Parameters<typeof lightGenerateImage>[0])

  it('参数袋经 wire profile 改名下发（未声明/未设置不下发）；b64_json → base64 结果', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'AAAA' }] }))
    const result = (await generate({
      paramValues: {
        size: '1024x1024',
        numImages: 2,
        negativePrompt: 'blur',
        seed: 42,
        numInferenceSteps: 20,
        cfg: 7.5
      }
    })) as { type: string; images: string[] }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/images/generations')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'img-model',
      prompt: 'a cat',
      size: '1024x1024',
      n: 2,
      negative_prompt: 'blur',
      seed: 42,
      num_inference_steps: 20
    })
    // diffusion profile 不声明 cfg → 丢弃（V2 mapped body 同样不带它）
    expect(JSON.parse(init.body as string)).not.toHaveProperty('cfg')
    expect(result).toEqual({ type: 'base64', images: ['AAAA'] })
  })

  it('url 响应归一为 url 类型', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] }))
    const result = (await generate()) as { type: string; images: string[] }
    expect(result).toEqual({ type: 'url', images: ['https://cdn.example.com/a.png'] })
  })

  it('HTTP 错误带状态码；requestId 注册可取消', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, 'busy'))
    await expect(generate()).rejects.toThrow('image generation failed (503): busy')

    // 取消注册表：abort 后 fetch 收到 signal.aborted
    const deferred = Promise.withResolvers<void>()
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          void deferred.promise.then(() => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const pending = generate({ requestId: 'req-1' })
    abortLightImage('req-1')
    deferred.resolve()
    await expect(pending).rejects.toThrow()
  })
})

describe('lightGenerateImage — provider wire profiles（v0.3.3 批次6 参数真正下发）', () => {
  it('openrouter：aspectRatio 归一化 + resolution/outputFormat/background 下发，seed/numImages 走 native', async () => {
    setLightLlmProviderRoutes([{ id: 'openrouter', apiHost: 'https://openrouter.ai/api/v1/', apiKey: 'sk-or' }])
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ url: 'https://cdn.example.com/o.png' }] }))
    await lightGenerateImage({
      provider: 'openrouter',
      model: 'flux-2-pro',
      prompt: 'a fox',
      wireProfileId: 'openrouter',
      supportedParams: ['aspectRatio', 'numImages', 'outputFormat', 'seed'],
      paramValues: { aspectRatio: 'ASPECT_16_9', numImages: 2, outputFormat: 'webp', seed: 7 }
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/images/generations')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'flux-2-pro',
      prompt: 'a fox',
      aspect_ratio: '16:9',
      n: 2,
      output_format: 'webp',
      seed: 7
    })
  })

  it('openai：background/moderation/quality 下发；seed 被 profile 明确排除（V2 OPENAI_WIRE_PROFILE 同）', async () => {
    setLightLlmProviderRoutes([{ id: 'openai', apiHost: 'https://api.openai.com', apiKey: 'sk-oai' }])
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'IM' }] }))
    await lightGenerateImage({
      provider: 'openai',
      model: 'gpt-image-1',
      prompt: 'a cup',
      wireProfileId: 'openai',
      supportedParams: ['background', 'moderation', 'numImages', 'quality', 'size'],
      paramValues: { background: 'transparent', moderation: 'low', quality: 'high', numImages: 1, size: '1024x1024' }
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // apiHost 不以 /v1 结尾 → 端点补 /v1（V2 OpenAI provider baseUrl 同）
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-image-1',
      prompt: 'a cup',
      background: 'transparent',
      moderation: 'low',
      quality: 'high',
      n: 1,
      size: '1024x1024'
    })
  })

  it('zhipu：baseUrl 已带 /api/paas/v4/ → 不再补 /v1；addWatermark → watermark', async () => {
    setLightLlmProviderRoutes([{ id: 'zhipu', apiHost: 'https://open.bigmodel.cn/api/paas/v4/', apiKey: 'sk-z' }])
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ url: 'https://cdn.example.com/z.png' }] }))
    await lightGenerateImage({
      provider: 'zhipu',
      model: 'glm-image',
      prompt: 'a bird',
      wireProfileId: 'zhipu',
      supportedParams: ['addWatermark', 'numImages', 'quality', 'size'],
      paramValues: { addWatermark: true, numImages: 1, quality: 'hd', size: '1280x1280' }
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'glm-image',
      prompt: 'a bird',
      watermark: true,
      n: 1,
      quality: 'hd',
      size: '1280x1280'
    })
  })

  it('supportedParams 过滤：模型没声明的键不进 wire', async () => {
    setLightLlmProviderRoutes([{ id: 'openai', apiHost: 'https://api.openai.com', apiKey: 'sk-oai' }])
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'IM' }] }))
    await lightGenerateImage({
      provider: 'openai',
      model: 'dall-e-3',
      prompt: 'a dog',
      wireProfileId: 'openai',
      supportedParams: ['quality', 'size', 'style'],
      // negativePrompt 是残留的旧值：dall-e-3 不声明它 → 必须不下发
      paramValues: { quality: 'hd', size: '1024x1024', style: 'vivid', negativePrompt: 'blur' }
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'dall-e-3',
      prompt: 'a dog',
      quality: 'hd',
      size: '1024x1024',
      style: 'vivid'
    })
  })

  it('范围外 provider（dashscope/ollama/minimax）明错，不发请求', async () => {
    setLightLlmProviderRoutes([
      { id: 'dashscope', apiHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', apiKey: 'sk-d' },
      { id: 'ollama', apiHost: 'http://localhost:11434', apiKey: '' },
      { id: 'minimax', apiHost: 'https://api.minimaxi.com/v1/', apiKey: 'sk-m' }
    ])
    for (const provider of ['dashscope', 'ollama', 'minimax']) {
      await expect(
        lightGenerateImage({
          provider,
          model: 'm',
          prompt: 'p',
          wireProfileId: provider,
          paramValues: { size: '1024x1024' }
        })
      ).rejects.toThrow('lightLlm: unsupported vendor')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dmxapi：provider override 的键面生效（dall-e-3 不带 numImages），quality 经 profile 下发', async () => {
    setLightLlmProviderRoutes([{ id: 'dmxapi', apiHost: 'https://www.dmxapi.cn', apiKey: 'sk-dmx' }])
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ url: 'https://cdn.example.com/d.png' }] }))
    await lightGenerateImage({
      provider: 'dmxapi',
      model: 'dall-e-3',
      prompt: 'a fish',
      paramValues: { size: '1024x1024', numImages: 1, quality: 'hd', style: 'vivid' }
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // dmxapi transport 固定带 response_format: 'url'（V2 submitOpenAIFlatFallback 同）
    expect(JSON.parse(init.body as string)).toEqual({
      response_format: 'url',
      model: 'dall-e-3',
      prompt: 'a fish',
      n: 1,
      size: '1024x1024',
      quality: 'hd'
    })
    expect(url).toBe('https://www.dmxapi.cn/v1/images/generations')
  })
})

describe('lightEditImage', () => {
  it('multipart /images/edits：data URL 解析出 blob 类型；参数袋按 profile 追加；逐张编辑聚合', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'BBB1' }] }))
      .mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'BBB2' }] }))
    const result = await lightEditImage({
      provider: 'silicon',
      model: 'img-model',
      prompt: 'make it blue',
      inputImages: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
      paramValues: { size: '1024x1024', negativePrompt: 'blur' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/images/edits')
    const form = init.body as FormData
    expect(form.get('model')).toBe('img-model')
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('negative_prompt')).toBe('blur')
    expect((form.get('image') as Blob).type).toBe('image/png')
    expect(result).toEqual({ type: 'base64', images: ['BBB1', 'BBB2'] })
  })

  it('空 inputImages 明错；范围外 provider 明错；HTTP 错误带状态码', async () => {
    await expect(lightEditImage({ provider: 'silicon', model: 'm', prompt: 'p', inputImages: [] })).rejects.toThrow(
      'invalid inputImages'
    )
    await expect(
      lightEditImage({ provider: 'dashscope', model: 'm', prompt: 'p', inputImages: ['data:image/png;base64,AAAA'] })
    ).rejects.toThrow('lightLlm: unsupported vendor')
    fetchMock.mockResolvedValueOnce(errorResponse(400, 'bad mask'))
    await expect(
      lightEditImage({ provider: 'silicon', model: 'm', prompt: 'p', inputImages: ['data:image/png;base64,AAAA'] })
    ).rejects.toThrow('image edit failed (400): bad mask')
  })
})
