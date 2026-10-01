/**
 * `useAppInit` 的 websearch → 内核投影只由**载荷真正读取的字段**决定。
 *
 * 此前 effect 依赖整个 `state.websearch` 切片对象（Redux 每次 websearch action 都产出新引用），
 * 于是拨动任意无关开关（defaultProvider/overwrite/providerConfig…，mini 窗口广播也算）都会把
 * 含 `apiKey`/`basicAuthPassword` 的完整 provider 清单重新跨进程推一次。
 * 这里钉住"无关变更不改变投影结果"（`useMemo` 的依赖即这些输入），以及"每个输入变更都真的
 * 反映到载荷里"（触发语义不被收窄破坏）。
 */
import { initialState, type WebSearchState } from '@renderer/store/websearch'
import { describe, expect, it } from 'vitest'

import { buildKernelWebSearchConfig } from '../useAppInit'

const baseState = (): WebSearchState => ({
  ...initialState,
  providers: [
    {
      id: 'local-bing',
      name: 'Bing',
      apiKey: 'secret-key',
      basicAuthPassword: 'secret-pass',
      engines: ['bing']
    } as unknown as WebSearchState['providers'][number]
  ],
  subscribeSources: [{ key: 1, url: 'https://example.com/list', name: 'list', blacklist: ['*://a.com/*'] }],
  excludeDomains: ['blocked.com'],
  searchWithTime: true,
  maxResults: 7,
  compressionConfig: {
    method: 'rag',
    documentCount: 3,
    embeddingModel: { id: 'emb-1', provider: 'p1' } as never,
    embeddingDimensions: 512,
    rerankModel: { id: 're-1', provider: 'p2' } as never
  }
})

const build = (state: WebSearchState, language = 'zh-CN') =>
  buildKernelWebSearchConfig({
    providers: state.providers,
    subscribeSources: state.subscribeSources,
    excludeDomains: state.excludeDomains,
    searchWithTime: state.searchWithTime,
    maxResults: state.maxResults,
    compressionConfig: state.compressionConfig,
    language
  })

describe('buildKernelWebSearchConfig', () => {
  it('投影包含全部消费字段（收窄 selector 不改变载荷形状）', () => {
    const config = build(baseState())
    expect(config.providers).toEqual([
      {
        id: 'local-bing',
        name: 'Bing',
        apiKey: 'secret-key',
        apiHost: undefined,
        url: undefined,
        engines: ['bing'],
        basicAuthUsername: undefined,
        basicAuthPassword: 'secret-pass',
        usingBrowser: undefined
      }
    ])
    // 黑名单 = 订阅源黑名单平铺；excludeDomains 单独透传
    expect(config.blacklist).toEqual(['*://a.com/*'])
    expect(config.excludeDomains).toEqual(['blocked.com'])
    expect(config.searchWithTime).toBe(true)
    expect(config.maxResults).toBe(7)
    expect(config.language).toBe('zh-CN')
    expect(config.compression).toMatchObject({
      method: 'rag',
      documentCount: 3,
      embedding: { providerId: 'p1', modelId: 'emb-1', dimensions: 512 },
      rerank: { providerId: 'p2', modelId: 're-1' }
    })
  })

  it('无关字段变更（defaultProvider/overwrite/providerConfig）不改变投影结果', () => {
    const state = baseState()
    const before = build(state)
    // 同一个 websearch 切片被无关 action 重建（引用变、载荷输入不变）
    const mutated = {
      ...state,
      defaultProvider: 'local-google',
      overwrite: true,
      providerConfig: { 'local-bing': { anything: 1 } }
    }
    const after = build(mutated)
    expect(after).toEqual(before)
  })

  it('每个被订阅的输入变更**都**反映到载荷（触发语义不变）', () => {
    const state = baseState()
    const before = build(state)
    const changes: Array<[string, WebSearchState]> = [
      ['providers', { ...state, providers: [{ ...state.providers[0], apiKey: 'rotated' }] }],
      ['subscribeSources', { ...state, subscribeSources: [] }],
      ['excludeDomains', { ...state, excludeDomains: ['other.com'] }],
      ['searchWithTime', { ...state, searchWithTime: false }],
      ['maxResults', { ...state, maxResults: 3 }],
      ['compressionConfig', { ...state, compressionConfig: { method: 'none', cutoffLimit: 100 } }]
    ]
    for (const [label, next] of changes) {
      expect(build(next), `${label} 变更必须改变载荷`).not.toEqual(before)
    }
    // language 不是切片字段，但同样属于触发面
    expect(build(state, 'en-US')).not.toEqual(before)
  })

  it('compressionConfig 清空 → compression 为 undefined（通道关闭语义不变）', () => {
    const state = baseState()
    expect(build({ ...state, compressionConfig: undefined }).compression).toBeUndefined()
    expect(build({ ...state, compressionConfig: { method: 'none' } }).compression).toMatchObject({
      method: 'none',
      embedding: undefined,
      rerank: undefined
    })
  })
})
