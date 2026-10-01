import type { Model, Provider } from '@renderer/types'
import { HealthStatus } from '@renderer/types/healthCheck'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 健康检查的失败语义（v1 二轮审查 s2-03）。
 *
 * 修改前：`Promise.all` 的 fail-fast 异常被 catch 吞掉，函数返回被截断的 `results`，
 * 调用方把「整体失败」渲染成「0/N 通过」的成功态，UI 无从表达失败。
 * 这里锁住新契约：定长数组 + 失败项带 FAILED 状态与可读错误文本 + 不 reject。
 */

const checkModelMock = vi.hoisted(() =>
  vi.fn<(provider: Provider, model: Model, timeout?: number) => Promise<unknown>>()
)

vi.mock('../ApiService', () => ({ checkModel: checkModelMock }))

import { checkModelsHealth } from '../HealthCheckService'

const model = (id: string): Model => ({ id, name: id, provider: 'p' }) as unknown as Model

const provider = { id: 'p', name: 'P', apiKey: 'k' } as unknown as Provider

beforeEach(() => {
  checkModelMock.mockReset()
})

describe('checkModelsHealth 的失败语义', () => {
  it('单个模型的意外异常不再截断整批结果：返回与 models 等长的定长数组', async () => {
    checkModelMock.mockImplementation((_provider, m) =>
      m.id === 'broken' ? Promise.reject(new Error('boom')) : Promise.resolve({ latency: 5 })
    )
    const models = [model('a'), model('broken'), model('c')]

    const results = await checkModelsHealth({ provider, models, apiKeys: ['k'], isConcurrent: true })

    expect(results).toHaveLength(3)
    expect(results.map((r) => r.model.id)).toEqual(['a', 'broken', 'c'])
  })

  it('密钥级失败时错误文本可读，不是 "[object Object]"', async () => {
    checkModelMock.mockImplementation(() => Promise.reject(new Error('401 unauthorized')))

    const results = await checkModelsHealth({
      provider,
      models: [model('a')],
      apiKeys: ['k'],
      isConcurrent: true
    })

    expect(results[0].status).toBe(HealthStatus.FAILED)
    expect(results[0].error).toContain('401 unauthorized')
    expect(results[0].error).not.toContain('[object Object]')
  })

  it('检查本身抛错时得到 FAILED + 空 keyResults + 可读错误文本（与「真测过」可区分）', async () => {
    const mod = await import('@renderer/utils/healthCheck')
    const spy = vi.spyOn(mod, 'aggregateApiKeyResults').mockImplementation(() => {
      throw new Error('agg-broke')
    })
    try {
      checkModelMock.mockImplementation(() => Promise.resolve({ latency: 3 }))

      const results = await checkModelsHealth({
        provider,
        models: [model('broken')],
        apiKeys: ['k'],
        isConcurrent: true
      })

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe(HealthStatus.FAILED)
      // 空 keyResults = 「检查本身没跑起来」；有 keyResults = 「真的测过」。
      expect(results[0].keyResults).toEqual([])
      expect(results[0].error).toContain('agg-broke')
    } finally {
      spy.mockRestore()
    }
  })

  it('整体失败时每一项都是 FAILED，且没有任何成功密钥 —— 调用方可判「整批失败」', async () => {
    checkModelMock.mockImplementation(() => Promise.reject(new Error('network down')))

    const results = await checkModelsHealth({
      provider,
      models: [model('a'), model('b')],
      apiKeys: ['k'],
      isConcurrent: false
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === HealthStatus.FAILED)).toBe(true)
    expect(results.some((r) => r.keyResults.some((kr) => kr.status === HealthStatus.SUCCESS))).toBe(false)
  })

  it('密钥级失败仍然走 keyResults —— 与「检查本身抛错」可区分', async () => {
    checkModelMock.mockImplementation(() => Promise.reject(new Error('401')))

    const results = await checkModelsHealth({
      provider,
      models: [model('a')],
      apiKeys: ['k'],
      isConcurrent: true
    })

    expect(results[0].status).toBe(HealthStatus.FAILED)
    expect(results[0].keyResults).toHaveLength(1)
    expect(results[0].keyResults[0].status).toBe(HealthStatus.FAILED)
  })

  it('onModelChecked 对每个下标都回调一次，即使该模型抛错', async () => {
    checkModelMock.mockImplementation((_provider, m) =>
      m.id === 'broken' ? Promise.reject(new Error('boom')) : Promise.resolve({ latency: 5 })
    )
    const seen: number[] = []

    await checkModelsHealth(
      { provider, models: [model('a'), model('broken')], apiKeys: ['k'], isConcurrent: true },
      (_r, i) => seen.push(i)
    )

    expect(seen.sort()).toEqual([0, 1])
  })
})
