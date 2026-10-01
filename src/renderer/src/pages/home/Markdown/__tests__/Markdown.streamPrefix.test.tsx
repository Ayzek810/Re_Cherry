/**
 * 流式期「稳定前缀复用 + 尾块重解析」。
 *
 * 证明两件事：
 *  1. 正文仍逐 delta 增长，最终全文正确（切分不丢字、不重字）；
 *  2. 同一段稳定前缀不被重复解析——`ReactMarkdown` 的调用次数；
 *  3. 不变量：`renderedPrefix + renderedTail === 当前全文`（任何一帧都成立）。
 *
 * 计数口径：真实 `react-markdown` 每次调用都会重跑 unified 管线，所以「前缀渲染次数」
 * 就是「管线对前缀执行的次数」。切分未启用（落定/短文本）时前缀为空，只有 tail 渲染。
 */
import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { reactMarkdownCalls } = vi.hoisted(() => ({
  reactMarkdownCalls: { prefixes: [] as string[], tails: [] as string[] }
}))

vi.mock('react-markdown', () => {
  type MockProps = { children?: unknown; components?: Record<string, (props: unknown) => unknown> }
  return {
    __esModule: true,
    defaultUrlTransform: (value: string) => value,
    default: ({ children }: MockProps) => {
      const source = typeof children === 'string' ? children : ''
      // 判定口径：先渲染的稳定前缀与 `markdownPrefixStats.lastPrefix` 相等（消费后清空，
      // 保证随后同帧渲染的尾块不会被误记为前缀）。
      if (source !== '' && source === markdownPrefixStats.lastPrefix) {
        reactMarkdownCalls.prefixes.push(source)
        markdownPrefixStats.lastPrefix = ''
      } else {
        reactMarkdownCalls.tails.push(source)
      }
      return null
    }
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = { mathEngine: 'none', mathEnableSingleDollar: true }
  // 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key as keyof typeof settings] }
})

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { EDIT_CODE_BLOCK: 'EDIT_CODE_BLOCK' },
  EventEmitter: { emit: vi.fn() }
}))

vi.mock('@renderer/utils/formats', () => ({ removeSvgEmptyLines: (str: string) => str }))
vi.mock('@renderer/utils/markdown', () => ({
  getCodeBlockId: vi.fn(() => null),
  processLatexBrackets: (str: string) => str
}))
// 本条测试针对普通 markdown 正文：工件直渲染分支（standaloneArtifact 早退）不参与
vi.mock('../standaloneHtmlArtifact', () => ({
  scanStandaloneHtmlArtifact: () => undefined
}))
vi.mock('../CodeBlock', () => ({ __esModule: true, default: () => null }))
vi.mock('@renderer/components/ImageViewer', () => ({ __esModule: true, default: () => null }))
vi.mock('../Link', () => ({ __esModule: true, default: () => null }))
vi.mock('../Table', () => ({ __esModule: true, default: () => null }))
vi.mock('../MarkdownSvgRenderer', () => ({ __esModule: true, default: () => null }))
vi.mock('@renderer/components/MarkdownShadowDOMRenderer', () => ({ __esModule: true, default: () => null }))
vi.mock('remark-alert', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('remark-gfm', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('remark-cjk-friendly', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('remark-math', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('rehype-raw', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('../plugins/remarkDisableConstructs', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('../plugins/rehypeHeadingIds', () => ({ __esModule: true, default: vi.fn() }))
vi.mock('../plugins/rehypeScalableSvg', () => ({ __esModule: true, default: vi.fn() }))

import Markdown, { markdownPrefixStats, splitStablePrefix } from '../Markdown'

const createStreamingBlock = (content: string): MainTextMessageBlock => ({
  id: 'block-prefix-test',
  messageId: 'msg-prefix-test',
  type: MessageBlockType.MAIN_TEXT,
  status: MessageBlockStatus.STREAMING,
  createdAt: new Date().toISOString(),
  content
})

/** 每段固定约 300 字节（远超 MIN_STABLE_PREFIX），便于确定性地断言切点位置。 */
const para = (n: number): string => `第 ${n} 段。` + '填充正文内容。'.repeat(40) + '\n\n'

const FULL = para(1) + para(2) + para(3) + para(4)

beforeEach(() => {
  reactMarkdownCalls.prefixes.length = 0
  reactMarkdownCalls.tails.length = 0
  markdownPrefixStats.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Markdown 流式尾块切分', () => {
  describe('splitStablePrefix', () => {
    it('切点落在空行上，tail 拼回等于原文', () => {
      const { prefix, tail } = splitStablePrefix(FULL)
      expect(prefix.length).toBeGreaterThanOrEqual(256)
      expect(prefix.endsWith('\n\n')).toBe(true)
      expect(prefix + tail).toBe(FULL)
      // 尾部留有余量（最后一个块边界不一定是切点）
      expect(tail.length).toBeGreaterThanOrEqual(32)
    })

    it('新块只有零星字符时不前移切点（帧内抖动不改变前缀 key）', () => {
      const base = para(1) + para(2) + para(3)
      // 第 4 段刚冒出几个字符：尾部余量不足，切点停在"第 2 段之后"
      const a = splitStablePrefix(base + '第 4 段开').prefix
      const b = splitStablePrefix(base + '第 4 段开头继续').prefix
      expect(a).toBe(para(1) + para(2))
      expect(b).toBe(a)
      // 第 4 段长足够后切点才前移
      const c = splitStablePrefix(base + para(4)).prefix
      expect(c.length).toBeGreaterThan(a.length)
    })

    it('未闭合围栏不切分（前缀会被渲染成残缺代码块）', () => {
      const text = para(1) + para(2) + '```ts\nconst a = 1\n'
      expect(splitStablePrefix(text)).toEqual({ prefix: '', tail: text })
    })

    it('已闭合围栏可以切分，且围栏整体落在同侧（不被截断）', () => {
      const text = para(1) + '```ts\nconst a = 1\n```\n\n' + para(2) + para(3)
      const { prefix, tail } = splitStablePrefix(text)
      expect(prefix + tail).toBe(text)
      expect(prefix.length).toBeGreaterThanOrEqual(256)
      // 围栏要么整体在前缀里、要么整体在尾块里；两侧都必须自带闭合标记
      const fence = '```ts\nconst a = 1\n```'
      const inPrefix = prefix.includes(fence)
      const inTail = tail.includes(fence)
      expect(inPrefix || inTail).toBe(true)
      expect(prefix.includes('```')).toBe(inPrefix)
      expect(tail.includes('```')).toBe(inTail)
    })

    it('未闭合 $$ 数学块不切分', () => {
      const text = para(1) + para(2) + '$$\na = b\n'
      expect(splitStablePrefix(text)).toEqual({ prefix: '', tail: text })
    })

    it('文本过短 / 空行不足 / 无空行时不切分', () => {
      expect(splitStablePrefix('短文本')).toEqual({ prefix: '', tail: '短文本' })
      const longSingleBlock = 'x'.repeat(600)
      expect(splitStablePrefix(longSingleBlock)).toEqual({ prefix: '', tail: longSingleBlock })
      // 只有一个块边界且余量不足 ⇒ 前缀达不到最小长度，不切
      const oneBoundary = para(5) + 'x'.repeat(20)
      expect(splitStablePrefix(oneBoundary).prefix).toBe('')
    })

    it('tail 永不以能改写上一块的构造开头（只能是新块的第一个字符）', () => {
      const text = para(1) + para(2) + '---\n\n' + para(3)
      const { tail } = splitStablePrefix(text)
      expect(/^(-{3,}|={3,}| {0,3}\|)/.test(tail)).toBe(false)
    })
  })

  describe('渲染行为', () => {
    /**
     * 真实链路：`useSmoothStream` 逐帧把累积文本推给 `Markdown`（生产路径）。
     * 断言窗口内逐帧记录的 (activePrefix, activeTail) 满足：
     *  - 每一帧 prefix + tail === 该帧显示的全文（不丢字、不重字）；
     *  - 稳定前缀的**管线执行**次数远少于帧数（缓存命中），即"同一段稳定前缀不被重复解析"。
     */
    const runStreamingHarness = async (frames: number, step: number): Promise<number[]> => {
      let setContent: ((value: string) => void) | null = null
      const Harness = () => {
        const [content, set] = useState(FULL.slice(0, 40))
        setContent = set
        return <Markdown block={createStreamingBlock(content)} />
      }
      render(<Harness />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      const observedRenders: number[] = []
      for (let i = 1; i <= frames; i++) {
        await act(async () => {
          setContent?.(FULL.slice(0, 40 + i * step))
        })
        // 等 rAF（useSmoothStream 的 playout 帧）跑一轮
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
        })
        observedRenders.push(markdownPrefixStats.prefixRenders)
      }
      return observedRenders
    }

    it('逐帧增长期：稳定前缀极少重解析、尾块逐帧重解析，且每帧都不丢字', async () => {
      const FRAMES = 40
      const STEP = 28
      const observedRenders = await runStreamingHarness(FRAMES, STEP)

      // 1) 不变量：切分自洽——前缀是全文的真前缀，且 prefix + tail 拼出同一份文本
      //    （切分只做切片，永不丢字/重字）
      const { activePrefix, activeTail } = markdownPrefixStats
      expect(activePrefix.length).toBeGreaterThanOrEqual(256)
      expect(activePrefix + activeTail).toBe(markdownPrefixStats.previewedContent)
      expect(markdownPrefixStats.previewedContent.startsWith(activePrefix)).toBe(true)
      expect(FULL.startsWith(activePrefix)).toBe(true)

      // 2) 同一段稳定前缀不再重复解析：管线执行次数只随"块边界前移"增长（这里 4 段正文），
      //    远小于帧数。改动前每个渲染帧都要对全文重跑一次管线。
      expect(markdownPrefixStats.prefixRenders).toBeGreaterThan(0)
      expect(markdownPrefixStats.prefixRenders).toBeLessThanOrEqual(4)
      expect(markdownPrefixStats.prefixReuses).toBeGreaterThan(FRAMES - 8)

      // 3) 前缀只在块边界前移时才变（同一前缀的连续帧只加 reuses，不重复渲染）
      const growsOnlyWithBoundaries = observedRenders.every((value, index) =>
        index === 0 ? true : value >= observedRenders[index - 1]
      )
      expect(growsOnlyWithBoundaries).toBe(true)

      // 4) 尾块确实逐帧重解析（内容各不相同），即正文仍在逐 delta 增长
      const distinctTails = new Set(reactMarkdownCalls.tails)
      expect(distinctTails.size).toBeGreaterThan(2)
    })

    it('落定后不再切分（整条消息由单一实例渲染，与改动前一致）', async () => {
      const settled: MainTextMessageBlock = { ...createStreamingBlock(FULL), status: MessageBlockStatus.SUCCESS }
      render(<Markdown block={settled} />)
      await act(async () => {
        await Promise.resolve()
      })

      expect(markdownPrefixStats.prefixRenders).toBe(0)
      expect(markdownPrefixStats.prefixReuses).toBe(0)
      expect(reactMarkdownCalls.prefixes).toHaveLength(0)
      // 全文一次渲染
      expect(reactMarkdownCalls.tails).toContain(FULL)
    })
  })
})
