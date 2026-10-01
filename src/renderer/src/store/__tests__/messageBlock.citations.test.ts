import { WEB_SEARCH_SOURCE } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { formatCitationsFromBlock, hostnameOf } from '../messageBlock'

/**
 * `formatCitationsFromBlock` 的 AISDK 分支曾裸用 `new URL(result.url).hostname`，
 * 而同函数的 GROK/OPENROUTER/OPENAI/ANTHROPIC 四条兄弟分支都包了 try/catch 并回落成原始 url。
 * 相对路径或畸形 url 会抛 TypeError，整个引用 selector（`selectFormattedCitationsByBlockId`）
 * 抛错 → 引用药丸整块不渲染。现在所有分支共用一个 `hostnameOf`。
 */
const blockOf = (source: string, results: unknown[]) =>
  ({
    id: 'block-1',
    type: 'citation',
    response: { source, results }
  }) as any

describe('hostnameOf', () => {
  it('正常 url 取 hostname；畸形/相对串回落为原串，不抛错', () => {
    expect(hostnameOf('https://example.com/a/b?q=1')).toBe('example.com')
    expect(hostnameOf('/relative/path')).toBe('/relative/path')
    expect(hostnameOf('not a url')).toBe('not a url')
    expect(hostnameOf('')).toBe('')
  })
})

describe('formatCitationsFromBlock — 畸形 url 不再打穿引用选择器', () => {
  it('AISDK：相对路径 url 不抛错，title 回落为原始 url', () => {
    const citations = formatCitationsFromBlock(blockOf(WEB_SEARCH_SOURCE.AISDK, [{ url: '/relative/path' }]))

    expect(citations).toHaveLength(1)
    expect(citations[0].url).toBe('/relative/path')
    expect(citations[0].title).toBe('/relative/path')
  })

  it('AISDK：畸形 url 与正常 url 混排时全部产出', () => {
    const citations = formatCitationsFromBlock(
      blockOf(WEB_SEARCH_SOURCE.AISDK, [
        { url: 'not a url' },
        { url: 'https://example.com/page' },
        { url: '/relative/path', title: '显式标题' }
      ])
    )

    expect(citations).toHaveLength(3)
    expect(citations[0].title).toBe('not a url')
    expect(citations[1].title).toBe('example.com')
    expect(citations[2].title).toBe('显式标题')
  })

  it('AISDK：正常 url 仍取 hostname', () => {
    const citations = formatCitationsFromBlock(blockOf(WEB_SEARCH_SOURCE.AISDK, [{ url: 'https://example.com/x' }]))

    expect(citations[0].title).toBe('example.com')
  })

  it('OPENROUTER / GROK：畸形 url 同样不抛错', () => {
    const openrouter = formatCitationsFromBlock(
      blockOf(WEB_SEARCH_SOURCE.OPENROUTER, [{ url: '/relative/path', title: '' }])
    )
    expect(openrouter[0].title).toBe('/relative/path')

    const grok = formatCitationsFromBlock(blockOf(WEB_SEARCH_SOURCE.GROK, [{ url: '/relative/path' }]))
    expect(grok[0].title).toBe('/relative/path')
  })

  it('ANTHROPIC：畸形 url 的 hostname 回落为原始 url', () => {
    const citations = formatCitationsFromBlock(
      blockOf(WEB_SEARCH_SOURCE.ANTHROPIC, [{ url: '/relative/path', title: 't' }])
    )

    expect(citations[0].hostname).toBe('/relative/path')
  })
})
