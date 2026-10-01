import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  // antd Table 的响应式观察器依赖 matchMedia（jsdom 未内置）
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

/**
 * 「更新选中订阅源」的整条链路。
 *
 * 修改前的契约：把 subscribeSources **整片替换**为本次解析成功的条目，未选中的订阅源
 * 连同它们已解析的 blacklist 一起消失，且照旧弹成功 toast。
 * 这里锁住修正后的契约，并覆盖「整体失败不得伪装成成功」。
 */

const parseSubscribeContentMock = vi.hoisted(() => vi.fn<(url: string) => Promise<string[]>>())

vi.mock('@renderer/utils/blacklistMatchPattern', async () => {
  const actual = await vi.importActual('@renderer/utils/blacklistMatchPattern')
  return { ...actual, parseSubscribeContent: parseSubscribeContentMock }
})

interface TestSource {
  key: number
  url: string
  name: string
  blacklist?: string[]
}

interface TestWebSearchState {
  subscribeSources: TestSource[]
  excludeDomains: string[]
  providers: unknown[]
}

const source = (key: number, name: string, blacklist?: string[]): TestSource => ({
  key,
  url: `https://example.com/${name}.txt`,
  name,
  blacklist
})

/** 内存版 websearch 切片：只认本测试关心的 action。 */
const mockState = vi.hoisted(() => {
  const makeState = (): TestWebSearchState => ({ subscribeSources: [], excludeDomains: [], providers: [] })
  const state = { current: makeState() }
  const dispatch = (action: { type: string; payload?: unknown }) => {
    if (action.type === 'websearch/setSubscribeSources') {
      state.current = { ...state.current, subscribeSources: action.payload as TestSource[] }
    }
    if (action.type === 'websearch/addSubscribeSource') {
      const payload = action.payload as Omit<TestSource, 'key'>
      state.current = {
        ...state.current,
        subscribeSources: [...state.current.subscribeSources, { key: 999, ...payload }]
      }
    }
    return action
  }
  const reset = (sources: TestSource[]) => {
    state.current = { ...makeState(), subscribeSources: sources }
  }
  return { state, dispatch, reset }
})

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mockState.dispatch,
  useAppSelector: (selector: (state: { websearch: TestWebSearchState }) => unknown) =>
    selector({ websearch: mockState.state.current })
}))

import BlacklistSettings from '../BlacklistSettings'

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  parseSubscribeContentMock.mockReset()
  window.toast = toast as unknown as typeof window.toast
})

const renderWith = (sources: TestSource[]) => {
  mockState.reset(sources)
  render(<BlacklistSettings />)
}

/** 行复选框：排除表头的「全选」（全选会把三条源都标成选中）。 */
const rowCheckboxes = () =>
  screen
    .getAllByRole('row')
    .filter((row) => row.querySelectorAll('th').length === 0)
    .flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>('input[type="checkbox"]')))

const clickUpdate = () => fireEvent.click(screen.getByRole('button', { name: /^(Update|立即更新)$/ }))

describe('更新选中订阅源', () => {
  it('只更新选中源的 blacklist，未选中源与其规则原样保留（整片替换回归）', async () => {
    const sources = [source(0, 'A', ['old-a']), source(1, 'B', ['keep-b']), source(2, 'C', ['keep-c'])]
    const parsed = ['new-a']
    parseSubscribeContentMock.mockImplementation(() => Promise.resolve(parsed))
    renderWith(sources)

    fireEvent.click(rowCheckboxes()[0])
    clickUpdate()

    await waitFor(() => expect(mockState.state.current.subscribeSources).toHaveLength(3))
    const after = mockState.state.current.subscribeSources
    expect(after.map((s) => s.key)).toEqual([0, 1, 2])
    expect(after[0].blacklist).toEqual(['new-a'])
    expect(after[1].blacklist).toEqual(['keep-b'])
    expect(after[2].blacklist).toEqual(['keep-c'])
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('全部选中源解析失败时弹 error，不弹成功，也不改动列表', async () => {
    const sources = [source(0, 'A', ['keep-a']), source(1, 'B', ['keep-b'])]
    parseSubscribeContentMock.mockImplementation(() => Promise.reject(new Error('network down')))
    renderWith(sources)

    fireEvent.click(rowCheckboxes()[0])
    clickUpdate()

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(mockState.state.current.subscribeSources).toEqual(sources)
  })

  it('解析结果为空视为该源失败，不得用空黑名单覆盖已有规则', async () => {
    parseSubscribeContentMock.mockImplementation(() => Promise.resolve([]))
    renderWith([source(0, 'A', ['keep-a'])])

    fireEvent.click(rowCheckboxes()[0])
    clickUpdate()

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(mockState.state.current.subscribeSources[0].blacklist).toEqual(['keep-a'])
  })

  it('部分成功时报「N 更新 / M 失败」，成功的那条仍然落库', async () => {
    parseSubscribeContentMock.mockImplementation((url: string) =>
      url.includes('A.txt') ? Promise.resolve(['new-a']) : Promise.reject(new Error('boom'))
    )
    renderWith([source(0, 'A', ['old-a']), source(1, 'B', ['keep-b'])])

    fireEvent.click(rowCheckboxes()[0])
    fireEvent.click(rowCheckboxes()[1])
    clickUpdate()

    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    const after = mockState.state.current.subscribeSources
    expect(after[0].blacklist).toEqual(['new-a'])
    expect(after[1].blacklist).toEqual(['keep-b'])
  })
})
