import { allMinApps } from '@renderer/config/minapps'
import minAppsReducer, { type MinAppsState, setPinnedMinApps } from '@renderer/store/minapps'
import type { MinAppType } from '@renderer/types'
import { describe, expect, it } from 'vitest'

// Test fixture factory
const createApp = (id: string, name?: string): MinAppType => ({
  id,
  name: name ?? id,
  url: `https://${id}.example.com`,
  logo: `logo-${id}`
})

describe('minApps slice — setPinnedMinApps', () => {
  const buildState = (pinned: MinAppType[]): MinAppsState =>
    ({
      enabled: [],
      disabled: [],
      pinned
    }) as MinAppsState

  it('replaces pinned list with new list', () => {
    const A = createApp('a')
    const B = createApp('b')
    const C = createApp('c')
    const state = buildState([A, B, C])

    const next = minAppsReducer(state, setPinnedMinApps([A, C]))

    expect(next.pinned.map((a) => a.id)).toEqual(['a', 'c'])
  })

  it('can set an empty pinned list', () => {
    const A = createApp('a')
    const state = buildState([A])

    const next = minAppsReducer(state, setPinnedMinApps([]))

    expect(next.pinned).toEqual([])
  })

  it('strips logo field from pinned apps', () => {
    const app = createApp('a')
    const state = buildState([])

    const next = minAppsReducer(state, setPinnedMinApps([app]))

    expect(next.pinned[0].logo).toBeUndefined()
    expect(next.pinned[0].id).toBe('a')
  })
})

/**
 * `initialState.enabled` 曾直接别名 `config/minapps.ts` 的模块数组 `allMinApps`
 * （元素对象也是同一批）。migrate 的 addMiniApp 又会把同一批对象 push 进持久化状态，
 * 于是「store 状态」与「配置模板」共用引用。初值处必须浅拷贝。
 */
describe('minApps slice — 初值不与 config 模块数组共享对象', () => {
  it('初值数组与每个 app 都是副本（值相等、引用不同）', () => {
    const state = minAppsReducer(undefined, { type: '@@INIT' })

    expect(state.enabled).not.toBe(allMinApps)
    expect(state.enabled).toHaveLength(allMinApps.length)

    state.enabled.forEach((app, index) => {
      expect(app).not.toBe(allMinApps[index])
      expect(app).toEqual(allMinApps[index])
    })
  })
})
