import { WEB_SEARCH_PROVIDERS } from '@renderer/config/webSearchProviders'
import { describe, expect, it } from 'vitest'

import websearch, { initialState, updateWebSearchProvider } from '../websearch'

/**
 * `initialState.providers` 曾直接别名 `config/webSearchProviders.ts` 的模块级数组
 * `WEB_SEARCH_PROVIDERS`（元素对象也是同一批）。模块表同时是「切片初值」与「配置模板」，
 * 任何落到它上面的写入都会污染同会话后续的初值/reset。这里钉住两条不变量：
 * ① 初值数组与每个元素都不是模块常量的同一对象；
 * ② `updateWebSearchProvider`（就地 `Object.assign` 语义）执行后，模块常量分毫不动。
 * 提示：本测试对 `initialState` 恒等（模块单例）做断言，所以第二个用例故意从
 * `websearch(undefined, …)` 起跑（reducer 的 undefined 分支就是 initialState）。
 */
describe('websearch slice — 初值不与配置模块常量共享对象', () => {
  it('初值数组与每个 provider 都是副本（值相等、引用不同）', () => {
    expect(initialState.providers).not.toBe(WEB_SEARCH_PROVIDERS)
    expect(initialState.providers).toHaveLength(WEB_SEARCH_PROVIDERS.length)

    initialState.providers.forEach((provider, index) => {
      expect(provider).not.toBe(WEB_SEARCH_PROVIDERS[index])
      expect(provider).toEqual(WEB_SEARCH_PROVIDERS[index])
    })
  })

  it('updateWebSearchProvider 不写入模块常量', () => {
    const target = WEB_SEARCH_PROVIDERS[0]
    const before = { ...target }

    const next = websearch(
      undefined,
      updateWebSearchProvider({ id: target.id, apiHost: 'https://example.invalid', name: '改名' })
    )

    const updated = next.providers.find((provider) => provider.id === target.id)
    expect(updated?.apiHost).toBe('https://example.invalid')
    expect(updated?.name).toBe('改名')

    // 模块常量原样：既没有被就地改，也没有被换成别的引用
    expect(WEB_SEARCH_PROVIDERS[0]).toEqual(before)
    expect(WEB_SEARCH_PROVIDERS[0]).toBe(target)
    // 初值也原样（updateWebSearchProvider 只改当前 state 的副本）
    expect(initialState.providers[0]).toEqual(before)
  })
})
