import type { Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { moveProvider } from '../llm'

/**
 * r2-30：`moveProvider(providers, id, position)` 的语义是 **1-based 目标位置**——
 * 结果数组的 `result[position - 1]` 就是被移动的那个 provider（不论它原先在目标之前还是之后）。
 * 实现是「先移除自己，再 `splice(position - 1, 0, provider)`」，所以结果下标恒为 `position - 1`。
 *
 * 审计曾疑「移除后偏移一位」（把语义读成「按移除前的下标插入」）。本文件把**被移者在目标之前**
 * 这一分歧场景钉住：按 1-based 目标位置语义，`['a','b','c','d','e']` 里把 'a' 移到 3 得
 * `['b','c','a','d','e']`（'a' 落在下标 2 / 第 3 格）；若按「移除前下标」实现则会得到
 * `['b','a','c','d','e']`（'a' 落在下标 1 / 第 2 格），与调用方给的 1-based 位置差一格。
 */
const mk = (...ids: string[]): Provider[] => ids.map((id) => ({ id }) as Provider)
const ids = (providers: Provider[]): string[] => providers.map((provider) => provider.id)

describe('moveProvider — 1-based 目标位置（r2-30）', () => {
  it('被移者在目标之前：落在第 position 格（不是第 position-1 格）', () => {
    const result = moveProvider(mk('a', 'b', 'c', 'd', 'e'), 'a', 3)

    expect(ids(result)).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(result[2].id).toBe('a')
  })

  it('被移者在目标之后：同样落在第 position 格', () => {
    const result = moveProvider(mk('a', 'b', 'c', 'd', 'e'), 'd', 2)

    expect(ids(result)).toEqual(['a', 'd', 'b', 'c', 'e'])
    expect(result[1].id).toBe('d')
  })

  it('移到首位（position = 1）与末位', () => {
    expect(ids(moveProvider(mk('a', 'b', 'c'), 'c', 1))).toEqual(['c', 'a', 'b'])
    expect(ids(moveProvider(mk('a', 'b', 'c'), 'a', 3))).toEqual(['b', 'c', 'a'])
  })

  it('已在目标位置 → 顺序不变', () => {
    expect(ids(moveProvider(mk('a', 'b', 'c'), 'b', 2))).toEqual(['a', 'b', 'c'])
  })

  it('未知 id → 原数组引用原样返回（不复制）', () => {
    const providers = mk('a', 'b')
    expect(moveProvider(providers, 'nope', 1)).toBe(providers)
  })

  it('不改动入参数组（纯函数）', () => {
    const providers = mk('a', 'b', 'c')
    moveProvider(providers, 'a', 3)
    expect(ids(providers)).toEqual(['a', 'b', 'c'])
  })

  it("migrate '112' 的连续三次移动落位：cephalon/302ai/lanyun = 13/14/15", () => {
    // 复刻该分支：先 append 三个 provider（addProvider 追加到尾部），再依次 moveProvider。
    const base = mk(...Array.from({ length: 20 }, (_, index) => `p${index + 1}`))
    let providers: Provider[] = [...base, ...mk('cephalon', '302ai', 'lanyun')]

    providers = moveProvider(providers, 'cephalon', 13)
    providers = moveProvider(providers, '302ai', 14)
    providers = moveProvider(providers, 'lanyun', 15)

    expect(ids(providers).slice(12, 15)).toEqual(['cephalon', '302ai', 'lanyun'])
    // 目标位之前的 12 格不受影响（被移者都在目标之后时不会前移）
    expect(ids(providers).slice(0, 12)).toEqual(ids(base).slice(0, 12))
    // 每个被移者都恰好出现一次
    expect(ids(providers).filter((id) => ['cephalon', '302ai', 'lanyun'].includes(id))).toHaveLength(3)
  })
})
