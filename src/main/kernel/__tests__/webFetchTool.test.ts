import { describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
const bumpMock = vi.hoisted(() => vi.fn(() => 0))

vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: fetchMock,
  isAbortError: (error: unknown): boolean => error instanceof Error && error.name === 'AbortError',
  noContent: 'No content found'
}))
vi.mock('@main/services/WebSearchService', () => ({
  webSearchService: { bumpTurnResultOffset: bumpMock }
}))

import { parseUrls, slicePage } from '../webFetchTool'

/**
 * web_fetch 机测：URL 解析/分页纯函数 + 真 defineTool 执行链（网络层与
 * 编号服务走模块替身）。钉住的语义：
 *   - URL 清单去重/协议白名单/上限；分页截断 + nextOffset
 *   - execute：单页失败不整批报错（失败条目进列表）；[n] 编号接续 bumpTurnResultOffset
 *   - 每轮登记缺失时编号从 1 起（agent-less/无话题不炸）
 */

function makeExec(topicId?: string): unknown {
  return {
    callId: 'c1',
    rootCallId: 'c1',
    name: 'web_fetch',
    arguments: {},
    token: Symbol('t'),
    ...(topicId === undefined ? {} : { agent: { session: { id: topicId, events: [] } } }),
    signal: new AbortController().signal
  }
}

async function buildTool(): Promise<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> {
  const { Context } = await import('@deepseek-ai/cordis')
  const module = await import('../webFetchTool')
  const ctx = new Context()
  const tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined = undefined
  const holder: { current?: typeof tool } = {}
  ;(ctx as unknown as { tools: { register: (definition: never) => void } }).tools = {
    register: (definition: never) => {
      holder.current = definition as unknown as typeof tool
    }
  }
  module.apply(ctx)
  if (holder.current === undefined) throw new Error('web_fetch tool not registered')
  return holder.current
}

describe('parseUrls', () => {
  it('http(s) 清单解析并去重保序', () => {
    expect(parseUrls(['https://a.example.com/x', 'http://b.example.com/', 'https://a.example.com/x'])).toEqual([
      'https://a.example.com/x',
      'http://b.example.com/'
    ])
  })

  it('非字符串/空清单/非 http 协议均具名报错', () => {
    expect(() => parseUrls('https://a.example.com')).toThrow(/array/)
    expect(() => parseUrls([])).toThrow(/empty url list/)
    expect(() => parseUrls([42])).toThrow(/array of strings/)
    expect(() => parseUrls(['ftp://a.example.com/x'])).toThrow(/only http\(s\)/)
    expect(() => parseUrls(['not a url'])).toThrow(/invalid URL/)
  })

  it('超过 5 条拒绝', () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://a.example.com/${i}`)
    expect(() => parseUrls(urls)).toThrow(/at most 5/)
  })
})

describe('slicePage', () => {
  const PAGE = 20000
  const content = 'y'.repeat(PAGE + 5000)

  it('截断给 nextOffset', () => {
    const page = slicePage(content, 0)
    expect(page.text).toHaveLength(PAGE)
    expect(page.truncated).toBe(true)
    expect(page.nextOffset).toBe(PAGE)
  })

  it('末段不截断', () => {
    const page = slicePage(content, PAGE + 4000)
    expect(page.text).toHaveLength(1000)
    expect(page.truncated).toBe(false)
    expect(page.nextOffset).toBeUndefined()
  })

  it('越界回空页', () => {
    expect(slicePage(content, 999999).text).toBe('')
  })

  it('非法 offset 回退首页', () => {
    expect(slicePage(content, Number.NaN).text).toHaveLength(PAGE)
  })
})

describe('execute（真 defineTool + 模块替身）', () => {
  it('成功页与失败页同列返回，编号接续每轮偏移', async () => {
    const tool = await buildTool()
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('good')) return { title: 'Good Page', url, content: 'page body' }
      throw new Error('network down')
    })
    bumpMock.mockReturnValue(3)
    const result = (await tool.execute(
      { urls: ['https://good.example.com/a', 'https://bad.example.com/b'] },
      makeExec('topic-1')
    )) as {
      results: number
      entries: Array<{ title: string; content: string }>
      text: string
    }
    expect(result.results).toBe(2)
    expect(result.entries[0]).toMatchObject({ title: 'Good Page', content: 'page body' })
    expect(result.entries[1].content).toContain('Fetch failed')
    expect(result.text).toContain('[4] Good Page')
    expect(bumpMock).toHaveBeenCalledWith('topic-1', 2)
  })

  it('agent-less 执行（无话题）编号从 1 起，不触编号服务', async () => {
    const tool = await buildTool()
    fetchMock.mockResolvedValue({ title: 'Solo', url: 'https://a.example.com/', content: 'body' })
    bumpMock.mockClear()
    const result = (await tool.execute({ urls: ['https://a.example.com/'] }, makeExec())) as { text: string }
    expect(result.text).toContain('[1] Solo')
    expect(bumpMock).not.toHaveBeenCalled()
  })

  it('空清单具名报错', async () => {
    const tool = await buildTool()
    await expect(tool.execute({ urls: [] }, makeExec('topic-1'))).rejects.toThrow(/empty url list/)
  })
})
