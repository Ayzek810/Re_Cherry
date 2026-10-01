/**
 * 第 2 条行为测试：代码块卸载必须把 callerId 交给 `ShikiStreamService.cleanupTokenizers`。
 *
 * 这条测试锁定的是**生产消费点确实存在**：`ShikiStreamService.cleanupTokenizers(callerId)`
 * 此前被审计判定为"生产路径没有可见的按 callerId 清理者"（`grep shikiStreamService.cleanupTokenizers`
 * 只命中 `CodeStyleProvider` 与测试——因为真正的调用点是 `useCodeHighlight` 经 `useCodeStyle()`
 * 拿到的 `cleanupTokenizers` 回调）。本测试把该回调替换成 spy，断言 hook 卸载时确实按
 * `callerId` 调用了它，且清理的是自己的 callerId。
 *
 * `CodeViewer` 是 `useCodeHighlight` 的**唯一**消费方，且每个实例用
 * useRef(`${Date.now()}-${uuid()}`).current 生成实例级 callerId；`CodeViewer` 的唯一生产
 * 挂载点是 `CodeBlockView`（Markdown 代码块）——因此"代码块卸载 ⇒ 清理该块的 tokenizer"
 * 这条链由本测试 + `CodeViewer.debounceCleanup.test.tsx` 共同覆盖。
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCodeHighlight } from '../useCodeHighlight'

const { cleanupTokenizersMock, highlightStreamingCodeMock } = vi.hoisted(() => ({
  cleanupTokenizersMock: vi.fn(),
  highlightStreamingCodeMock: vi.fn(async () => ({ lines: [], recall: 0 }))
}))

vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: () => ({
    activeShikiTheme: 'one-light',
    highlightStreamingCode: highlightStreamingCodeMock,
    cleanupTokenizers: cleanupTokenizersMock,
    getShikiPreProperties: async () => ({ class: '', style: '', tabindex: 0 }),
    isShikiThemeDark: false
  })
}))

describe('useCodeHighlight unmount cleanup (#2)', () => {
  beforeEach(() => {
    cleanupTokenizersMock.mockClear()
    highlightStreamingCodeMock.mockClear()
  })

  it('calls cleanupTokenizers with its own callerId on unmount', () => {
    const callerId = 'block-level-caller'
    const { unmount } = renderHook(() =>
      useCodeHighlight({ rawLines: ['const a = 1'], language: 'typescript', callerId })
    )

    expect(cleanupTokenizersMock).not.toHaveBeenCalled()
    unmount()

    expect(cleanupTokenizersMock).toHaveBeenCalledTimes(1)
    expect(cleanupTokenizersMock).toHaveBeenCalledWith(callerId)
  })

  it('does not clean up another callerId', () => {
    const callerId = 'caller-a'
    const { unmount } = renderHook(() =>
      useCodeHighlight({ rawLines: ['const a = 1'], language: 'typescript', callerId })
    )
    unmount()

    const cleaned = cleanupTokenizersMock.mock.calls.map((call) => call[0])
    expect(cleaned).toEqual([callerId])
    expect(cleaned).not.toContain('caller-b')
  })

  it('cleans up exactly once per mount (no leak of the previous callerId)', () => {
    const { unmount, rerender } = renderHook(
      ({ callerId }: { callerId: string }) =>
        useCodeHighlight({ rawLines: ['const a = 1'], language: 'typescript', callerId }),
      { initialProps: { callerId: 'first-caller' } }
    )

    // callerId 变化 ⇒ 旧 effect 清理一次（旧 callerId），新 effect 不清理
    rerender({ callerId: 'second-caller' })
    expect(cleanupTokenizersMock.mock.calls.map((call) => call[0])).toEqual(['first-caller'])

    unmount()
    expect(cleanupTokenizersMock.mock.calls.map((call) => call[0])).toEqual(['first-caller', 'second-caller'])
  })
})
