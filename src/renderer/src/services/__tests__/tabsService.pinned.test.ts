/**
 * 固定标签页的**持久化**契约（v0.3.3-1）。
 *
 * `tabs` 切片在 redux-persist 的 `blacklist` 里（fork 的标签页本就只在会话内），所以"固定"
 * 要跨重启保留，必须把固定集合镜像进已持久化的 `settings.pinnedTabs`，并在启动时补回。
 * 本测试用真 store 驱动服务，钉住三件事：
 *   - pin/unpin 后集合随之增删；
 *   - **关掉一个固定标签页**时集合也要收（否则重启会把它复活）；
 *   - restore 幂等，且缺的行按记录补回并置 `isPinned`。
 */
import store from '@renderer/store'
import { addTab, setActiveTab, setTabs } from '@renderer/store/tabs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import tabsService from '../TabsService'

vi.mock('@renderer/utils/webviewStateManager', () => ({ clearWebviewState: vi.fn() }))

const tab = (id: string, path = `/${id}`) => ({ id, path })

const pinnedIds = () => (store.getState().settings.pinnedTabs ?? []).map((row) => row.id)
const tabIds = () => store.getState().tabs.tabs.map((row) => row.id)

const resetStore = () => {
  store.dispatch(setTabs([tab('home', '/'), tab('a'), tab('b')]))
  store.dispatch(setActiveTab('home'))
  store.dispatch({ type: 'settings/setPinnedTabs', payload: [] })
}

describe('TabsService · 固定标签页的持久化', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('pin/unpin 镜像进 settings.pinnedTabs', () => {
    expect(tabsService.togglePin('a')).toBe(true)
    expect(pinnedIds()).toEqual(['a'])

    expect(tabsService.togglePin('a')).toBe(true)
    expect(pinnedIds()).toEqual([])
  })

  it('关掉固定标签页时集合同步收紧（不复活）', () => {
    tabsService.togglePin('b')
    expect(pinnedIds()).toEqual(['b'])

    tabsService.closeTab('b')

    expect(tabIds()).toEqual(['home', 'a'])
    expect(pinnedIds()).toEqual([])
  })

  it('关闭其他标签页保留固定页与首页，集合不变', () => {
    tabsService.togglePin('b')
    tabsService.closeOtherTabs('a')

    expect(tabIds()).toEqual(['home', 'b', 'a'])
    expect(pinnedIds()).toEqual(['b'])
  })

  it('启动恢复：缺的固定页补回标签条并置 isPinned，重复调用无副作用', () => {
    // 通过服务固定（真实路径会写入 settings.pinnedTabs）
    tabsService.togglePin('a')
    expect(pinnedIds()).toEqual(['a'])
    // 模拟"重启"后的状态：tabs 只剩 home，固定集合还在 settings 里
    store.dispatch(setTabs([tab('home', '/')]))

    tabsService.restorePinnedTabs()
    // 首页恒在第一位（用户点名），固定页紧随其后
    expect(tabIds()).toEqual(['home', 'a'])
    expect(store.getState().tabs.tabs[1].isPinned).toBe(true)

    // 幂等：再调一次不产生重复行
    const before = store.getState().tabs.tabs
    tabsService.restorePinnedTabs()
    expect(tabIds()).toEqual(['home', 'a'])
    expect(store.getState().tabs.tabs).toEqual(before)
  })

  it('启动恢复：已在清单里的行只补 isPinned，不重复插入（首页仍在最前）', () => {
    tabsService.togglePin('a')
    store.dispatch(setActiveTab('home'))
    // 模拟重启后行还在但丢了 pin 标记
    store.dispatch(setTabs([{ ...tab('home', '/') }, { ...tab('a') }, { ...tab('b') }]))

    tabsService.restorePinnedTabs()

    expect(tabIds()).toEqual(['home', 'a', 'b'])
    expect(store.getState().tabs.tabs.find((row) => row.id === 'a')?.isPinned).toBe(true)
  })

  it('新增普通标签页不污染固定集合', () => {
    store.dispatch(addTab(tab('c')))
    expect(pinnedIds()).toEqual([])
  })
})
