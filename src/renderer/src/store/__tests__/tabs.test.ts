/**
 * 标签页固定（v0.3.3 用户点名功能）的语义契约，逐条对齐 V2：
 * - `isPinned` 的标签页进"固定区"，**固定区恒在普通区之前**；
 * - 固定 → 追加到固定区**末尾**，取消固定 → 追加到普通区**末尾**（V2 `pinTab`/`unpinTab`）；
 * - **批量关闭只作用于普通区**：`closeOtherTabs` 保留目标 + 全部固定标签页，并在当前激活页被关掉时改指目标页；
 * - 拖拽可以横跨两区，但 `setTabs` 会把"固定在前"的不变式补回来。
 */
import { describe, expect, it } from 'vitest'

import reducer, {
  addTab,
  closeOtherTabs,
  removeTab,
  restorePinnedTabs,
  setActiveTab,
  setTabs,
  type Tab,
  type TabsState,
  toggleTabPin
} from '../tabs'

const tab = (id: string, path = `/${id}`, isPinned?: boolean): Tab => ({
  id,
  path,
  ...(isPinned === undefined ? {} : { isPinned })
})

const stateOf = (tabs: Tab[], activeTabId = tabs[0]?.id ?? 'home'): TabsState => ({ tabs, activeTabId })

describe('tabs slice · 固定标签页', () => {
  it('固定标签页追加到固定区末尾，且固定区恒在普通区之前', () => {
    let state = stateOf([tab('a'), tab('b'), tab('c'), tab('p', '/p', true)])

    state = reducer(state, toggleTabPin('b'))

    expect(state.tabs.map((item) => `${item.id}:${item.isPinned === true ? 'pin' : 'normal'}`)).toEqual([
      'p:pin',
      'b:pin',
      'a:normal',
      'c:normal'
    ])
  })

  it('取消固定后追加到普通区末尾', () => {
    let state = stateOf([tab('p1', '/p1', true), tab('p2', '/p2', true), tab('a'), tab('b')])

    state = reducer(state, toggleTabPin('p1'))

    expect(state.tabs.map((item) => item.id)).toEqual(['p2', 'a', 'b', 'p1'])
    expect(state.tabs.find((item) => item.id === 'p1')?.isPinned).toBe(false)
  })

  it('首页恒在第一位：固定别的标签页不会顶掉它', () => {
    // 复刻用户报的形态：home + a + b，固定 b
    let state = stateOf([tab('home', '/'), tab('a'), tab('b')], 'a')

    state = reducer(state, toggleTabPin('b'))

    expect(state.tabs.map((item) => item.id)).toEqual(['home', 'b', 'a'])
    expect(state.tabs[1].isPinned).toBe(true)

    // 再固定 a：固定区整体仍在首页之后
    state = reducer(state, toggleTabPin('a'))
    expect(state.tabs.map((item) => item.id)).toEqual(['home', 'b', 'a'])
  })

  it('首页恒在第一位：拖拽把它挪走也会被补回', () => {
    let state = stateOf([tab('home', '/'), tab('p', '/p', true), tab('a')], 'home')

    state = reducer(state, setTabs([tab('p', '/p', true), tab('a'), tab('home', '/')]))

    expect(state.tabs.map((item) => item.id)).toEqual(['home', 'p', 'a'])
  })

  it('未知 id 不改动状态', () => {
    const state = stateOf([tab('a')])
    expect(reducer(state, toggleTabPin('missing'))).toEqual(state)
  })

  it('关闭其他标签页时固定标签页豁免，并保留目标页', () => {
    let state = stateOf([tab('p', '/p', true), tab('a'), tab('b'), tab('c')], 'b')

    state = reducer(state, closeOtherTabs('b'))

    expect(state.tabs.map((item) => item.id)).toEqual(['p', 'b'])
    // 目标页本来就在，激活页不变
    expect(state.activeTabId).toBe('b')
  })

  it('关闭其他标签页把激活页改指目标页（激活页在普通区且被关掉时）', () => {
    let state = stateOf([tab('p', '/p', true), tab('a'), tab('b')], 'a')

    state = reducer(state, closeOtherTabs('b'))

    expect(state.tabs.map((item) => item.id)).toEqual(['p', 'b'])
    expect(state.activeTabId).toBe('b')
  })

  it('关闭其他标签页不关首页（首页常驻，恒在最前）', () => {
    let state = stateOf([tab('home', '/'), tab('a'), tab('b')], 'b')

    state = reducer(state, closeOtherTabs('b'))

    expect(state.tabs.map((item) => item.id)).toEqual(['home', 'b'])
  })

  it('从固定标签页发起关闭其他：普通区全清，固定区保留两个', () => {
    let state = stateOf([tab('p1', '/p1', true), tab('p2', '/p2', true), tab('a'), tab('b')], 'a')

    state = reducer(state, closeOtherTabs('p1'))

    expect(state.tabs.map((item) => item.id)).toEqual(['p1', 'p2'])
    expect(state.activeTabId).toBe('p1')
  })

  it('拖拽横跨两区后由 setTabs 补回"固定在前"（区内相对序不变）', () => {
    let state = stateOf([tab('p', '/p', true), tab('a'), tab('b')])

    state = reducer(state, setTabs([tab('a'), tab('p', '/p', true), tab('b')]))

    expect(state.tabs.map((item) => item.id)).toEqual(['p', 'a', 'b'])
  })

  it('新增标签页照旧落在普通区末尾，关闭与激活语义不变', () => {
    let state = stateOf([tab('p', '/p', true), tab('a')], 'a')

    state = reducer(state, addTab(tab('b')))
    expect(state.tabs.map((item) => item.id)).toEqual(['p', 'a', 'b'])
    expect(state.activeTabId).toBe('b')

    state = reducer(state, setActiveTab('a'))
    state = reducer(state, removeTab('a'))
    expect(state.tabs.map((item) => item.id)).toEqual(['p', 'b'])
    expect(state.activeTabId).toBe('b')
  })

  describe('restorePinnedTabs（跨重启恢复，v0.3.3-1 持久化）', () => {
    it('补回缺失的固定页并置 isPinned，首页仍在最前', () => {
      let state = stateOf([tab('home', '/')], 'home')

      state = reducer(state, restorePinnedTabs([{ id: 'settings', path: '/settings/provider' }]))

      expect(state.tabs.map((item) => `${item.id}:${item.isPinned === true ? 'pin' : 'normal'}`)).toEqual([
        'home:normal',
        'settings:pin'
      ])
      expect(state.tabs[1].path).toBe('/settings/provider')
    })

    it('已在清单里的只补 isPinned（不重复插入）', () => {
      let state = stateOf([tab('home', '/'), tab('a')], 'a')

      state = reducer(state, restorePinnedTabs([{ id: 'a', path: '/a' }]))

      expect(state.tabs.map((item) => item.id)).toEqual(['home', 'a'])
      expect(state.tabs[1].isPinned).toBe(true)
    })

    it('无可变化时返回原 state（幂等，不触发无谓刷新）', () => {
      const state = stateOf([tab('p', '/p', true), tab('a')])
      const next = reducer(state, restorePinnedTabs([{ id: 'p', path: '/p' }]))
      expect(next).toBe(state)
    })

    it('空记录是无操作', () => {
      const state = stateOf([tab('a')])
      expect(reducer(state, restorePinnedTabs([]))).toBe(state)
    })
  })
})
