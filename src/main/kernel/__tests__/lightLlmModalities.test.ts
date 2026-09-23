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
      okResponse({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }] })
    )
    const result = await lightRerank({ providerId: 'silicon', modelId: 'rerank-m', query: 'q', documents: ['a', 'b', 'c'] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/rerank')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'rerank-m', query: 'q', documents: ['a', 'b', 'c'] })
    expect(result.results).toEqual([{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }])
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
    await expect(
      lightRerank({ providerId: 'silicon', modelId: 'm', query: 'q', documents: ['a'] })
    ).rejects.toThrow('rerank request failed (500): boom')
  })
})

describe('lightGenerateImage', () => {
  const generate = (overrides: Record<string, unknown> = {}): Promise<unknown> =>
    lightGenerateImage({
      provider: 'silicon',
      model: 'img-model',
      prompt: 'a cat',
      imageSize: '1024x1024',
      batchSize: 1,
      ...overrides
    } as Parameters<typeof lightGenerateImage>[0])

  it('参数透传（camel→snake，未设置不下发）；b64_json → base64 结果', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'AAAA' }] }))
    const result = (await generate({ negativePrompt: 'blur', seed: '42', numInferenceSteps: 20 })) as {
      type: string
      images: string[]
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/images/generations')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'img-model',
      prompt: 'a cat',
      size: '1024x1024',
      n: 1,
      negative_prompt: 'blur',
      seed: '42',
      num_inference_steps: 20
    })
    expect(result).toEqual({ type: 'base64', images: ['AAAA'] })
  })

  it('url 响应归一为 url 类型；batchSize 越界明错', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] }))
    const result = (await generate()) as { type: string; images: string[] }
    expect(result).toEqual({ type: 'url', images: ['https://cdn.example.com/a.png'] })
    await expect(generate({ batchSize: 0 })).rejects.toThrow('invalid batchSize')
    await expect(generate({ batchSize: 9 })).rejects.toThrow('invalid batchSize')
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

describe('lightEditImage', () => {
  it('multipart /images/edits：data URL 解析出 blob 类型；逐张编辑聚合', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'BBB1' }] }))
      .mockResolvedValueOnce(okResponse({ data: [{ b64_json: 'BBB2' }] }))
    const result = await lightEditImage({
      provider: 'silicon',
      model: 'img-model',
      prompt: 'make it blue',
      inputImages: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
      imageSize: '1024x1024'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/images/edits')
    const form = init.body as FormData
    expect(form.get('model')).toBe('img-model')
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('size')).toBe('1024x1024')
    expect((form.get('image') as Blob).type).toBe('image/png')
    expect(result).toEqual({ type: 'base64', images: ['BBB1', 'BBB2'] })
  })

  it('空 inputImages 明错；HTTP 错误带状态码', async () => {
    await expect(
      lightEditImage({ provider: 'silicon', model: 'm', prompt: 'p', inputImages: [] })
    ).rejects.toThrow('invalid inputImages')
    fetchMock.mockResolvedValueOnce(errorResponse(400, 'bad mask'))
    await expect(
      lightEditImage({ provider: 'silicon', model: 'm', prompt: 'p', inputImages: ['data:image/png;base64,AAAA'] })
    ).rejects.toThrow('image edit failed (400): bad mask')
  })
})
