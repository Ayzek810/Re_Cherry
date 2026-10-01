/**
 * CodeViewer 的 300ms 防抖高亮必须在卸载时取消。
 *
 * 缺陷原状：`debouncedHighlightLines` 从不 cancel（同文件的 100ms selection 防抖是 cancel 的），
 * 卸载后定时器照常到点，走到 useCodeHighlight 的 setTokenLines（已卸载实例 setState），
 * 并让 ShikiStreamService 对已释放的 tokenizer 续跑。
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CodeViewer from '../CodeViewer'

const { highlightStreamingCodeMock, cleanupTokenizersMock } = vi.hoisted(() => ({
  highlightStreamingCodeMock: vi.fn(async () => ({ lines: [], recall: -1 })),
  cleanupTokenizersMock: vi.fn()
}))

vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: () => ({
    activeShikiTheme: 'github-light',
    highlightStreamingCode: highlightStreamingCodeMock,
    cleanupTokenizers: cleanupTokenizersMock,
    getShikiPreProperties: vi.fn(async () => ({})),
    isShikiThemeDark: false
  })
}))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = { fontSize: 14, codeShowLineNumbers: true, codeEditor: { keymap: true } }
  // 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key] }
})

// jsdom 量不出滚动容器高度，虚拟列表会返回 0 行，渐进式高亮的 effect 根本不会跑。
// 这里只把虚拟项收敛到固定的几行，好让被测路径真的被执行到。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, start: index * 22, size: 22, key: index })),
    getTotalSize: () => options.count * 22,
    measureElement: vi.fn()
  })
}))

const CODE = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4'].join('\n')

describe('CodeViewer debounced highlight cleanup', () => {
  beforeEach(() => {
    highlightStreamingCodeMock.mockClear()
    cleanupTokenizersMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels the pending debounce instead of highlighting after unmount', () => {
    vi.useFakeTimers()

    const { unmount } = render(<CodeViewer value={CODE} language="typescript" expanded />)

    // 让渐进式高亮的调度跑起来（防抖窗口是 300ms）。
    vi.advanceTimersByTime(50)
    unmount()

    // 卸载后越过 300ms 防抖窗口：高亮请求不允许再发出。
    vi.advanceTimersByTime(1000)
    expect(highlightStreamingCodeMock).not.toHaveBeenCalled()
  })

  it('still highlights while the viewer stays mounted', () => {
    vi.useFakeTimers()

    render(<CodeViewer value={CODE} language="typescript" expanded />)

    vi.advanceTimersByTime(1000)
    expect(highlightStreamingCodeMock).toHaveBeenCalled()
  })
})
