/**
 * r2-34 行为测试：`streamDone` 翻转不得重建/重启 playout 的 rAF 循环。
 *
 * 改动前 `renderLoop` 的依赖数组含 `streamDone`，于是：
 *   `streamDone` 翻转 → `renderLoop` 换 identity → `ensureLoop` 换 identity
 *   → 挂载 effect 依赖变化 → cleanup `cancelAnimationFrame` 并重新 `ensureLoop()`。
 * 即每次流结束都必然取消在途帧并重建循环。
 *
 * 证据是行为级的：翻转 `streamDone` 时不得出现 `cancelAnimationFrame`
 * （只有挂载 effect 的 cleanup 与 `reset` 会取消帧），且收尾后显示文本与输入逐字一致
 * （不因循环重建而丢字）。时序用真实 rAF 轮询等待，不比较帧数。
 */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSmoothStream } from '../useSmoothStream'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async (predicate: () => boolean, timeoutMs = 8000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(20)
  }
  return predicate()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSmoothStream r2-34：循环 identity 稳定', () => {
  it('streamDone 翻转不取消在途帧（不重建循环），且最终文本不变', async () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const texts: string[] = []
    const { result, rerender } = renderHook(
      ({ isDone }: { isDone: boolean }) =>
        useSmoothStream({
          onUpdate: (text) => texts.push(text),
          streamDone: isDone,
          initialText: ''
        }),
      { initialProps: { isDone: false } }
    )

    const payload = '循环身份-' + '填充字符。'.repeat(20)
    result.current.addChunk(payload)

    // 等到循环真的在跑（至少落过一发回调，帧在途）
    await waitUntil(() => texts.length > 0, 5000)
    expect(texts.length).toBeGreaterThan(0)

    // streamDone 翻转（生产路径：流结束 / 外部 !isTranslating）
    const cancelsBefore = cancelSpy.mock.calls.length
    rerender({ isDone: true })

    // 关键断言：翻转不得触发挂载 effect 的 cleanup（旧实现每次翻转都会 cancel 一次）
    expect(cancelSpy.mock.calls.length).toBe(cancelsBefore)

    // 收尾后全文送达（循环没被中途掐断）
    const shown = (): string => texts[texts.length - 1] ?? ''
    await waitUntil(() => shown() === payload, 8000)
    expect(shown()).toBe(payload)
  })

  it('外部 streamDone 反复翻转（true→false→true）不产生额外取消', async () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const texts: string[] = []
    const { result, rerender } = renderHook(
      ({ isDone }: { isDone: boolean }) =>
        useSmoothStream({ onUpdate: (text) => texts.push(text), streamDone: isDone, initialText: '' }),
      { initialProps: { isDone: false } }
    )

    result.current.addChunk('甲'.repeat(30))
    await waitUntil(() => texts.length > 0, 5000)

    const before = cancelSpy.mock.calls.length
    rerender({ isDone: true })
    await wait(30)
    rerender({ isDone: false })
    await wait(30)
    rerender({ isDone: true })

    expect(cancelSpy.mock.calls.length).toBe(before)
  })
})
