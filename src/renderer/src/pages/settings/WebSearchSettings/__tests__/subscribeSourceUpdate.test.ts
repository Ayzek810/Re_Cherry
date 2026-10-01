import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「更新选中订阅源」的合并语义。
 *
 * 旧实现把订閲源列表整片替换为本次解析成功的条目：未选中的订閲源连同已解析的
 * blacklist 一起消失，而按钮文案是「更新选中的订閲源」。这里锁住按 key 合并的契约，
 * 以及「选中集为空 = 无效输入」「整批解析失败 = 不得假成功」两条判定。
 *
 * 解析函数由调用方注入，所以本文件不需要 mock 网络层。
 */

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined
}))

import { mergeSubscribeSources, parseSelectedSubscribeSources } from '../subscribeSourceUpdate'

const row = (key: number, name: string) => ({ key, url: `https://example.com/${name}.txt`, name })

const parseMock = vi.hoisted(() => vi.fn<(url: string) => Promise<string[]>>())

beforeEach(() => {
  parseMock.mockReset()
})

describe('mergeSubscribeSources', () => {
  it('只覆盖本次更新到的 key，未选中源与其 blacklist 原样保留', () => {
    const existing = [
      { key: 0, url: 'https://a', name: 'A', blacklist: ['old-a'] },
      { key: 1, url: 'https://b', name: 'B', blacklist: ['keep-b'] },
      { key: 2, url: 'https://c', name: 'C', blacklist: ['keep-c'] }
    ]

    const { sources, updatedCount } = mergeSubscribeSources(existing, [
      { key: 0, url: 'https://a', name: 'A', blacklist: ['new-a'] }
    ])

    expect(updatedCount).toBe(1)
    expect(sources.map((s) => s.key)).toEqual([0, 1, 2])
    expect(sources[0].blacklist).toEqual(['new-a'])
    expect(sources[1]).toEqual(existing[1])
    expect(sources[2]).toEqual(existing[2])
  })

  it('列表里有但本次没被选中的源，不做任何新增或删除', () => {
    const existing = [{ key: 5, url: 'https://e', name: 'E', blacklist: ['e'] }]

    const { sources } = mergeSubscribeSources(existing, [])

    expect(sources).toEqual(existing)
  })

  it('更新条目不在现有列表里时追加（不静默丢弃）', () => {
    const { sources } = mergeSubscribeSources([], [{ key: 9, url: 'https://n', name: 'N', blacklist: ['n'] }])

    expect(sources).toEqual([{ key: 9, url: 'https://n', name: 'N', blacklist: ['n'] }])
  })
})

describe('parseSelectedSubscribeSources', () => {
  it('逐条解析，单条失败不影响其它条目', async () => {
    parseMock.mockImplementation((url: string) =>
      url.includes('A.txt') ? Promise.resolve(['new-a']) : Promise.reject(new Error('boom'))
    )

    const outcome = await parseSelectedSubscribeSources([row(0, 'A'), row(1, 'B')], parseMock)

    expect(outcome.updated).toEqual([{ key: 0, url: 'https://example.com/A.txt', name: 'A', blacklist: ['new-a'] }])
    expect(outcome.failed.map((f) => f.key)).toEqual([1])
  })

  it('解析出空列表按失败计，避免用空黑名单覆盖已解析规则', async () => {
    parseMock.mockImplementation(() => Promise.resolve([]))

    const outcome = await parseSelectedSubscribeSources([row(0, 'A')], parseMock)

    expect(outcome.updated).toEqual([])
    expect(outcome.failed.map((f) => f.key)).toEqual([0])
  })
})
