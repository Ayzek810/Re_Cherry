import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import {
  computeDisplayMessages,
  displayOrderKey,
  EMPTY_DISPLAY_ORDER_CACHE,
  projectDisplayMessages,
  resolveDisplayOrder
} from '../displayWindow'

const message = (id: string, role: Message['role'], askId = `ask-${id}`) =>
  ({ id, role, askId, blocks: [] }) as unknown as Message

describe('computeDisplayMessages', () => {
  it('returns the newest messages first when the rest fits the window', () => {
    const messages = [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user')]

    expect(computeDisplayMessages(messages, 0, 10).map((m) => m.id)).toEqual(['u2', 'a1', 'u1'])
  })

  it('counts one window slot per user message and per assistant askId, keeping parallel answers', () => {
    const messages = [
      message('u1', 'user'),
      message('a1', 'assistant', 'ask-1'),
      message('a2', 'assistant', 'ask-1'),
      message('u2', 'user'),
      message('a3', 'assistant', 'ask-2')
    ]

    // 窗口 = 2 个槽位（倒数第一条 u2 与 a3 同属一个 ask？后者 askId 不同）→ 从最新往前取满 2 个槽位
    const window = computeDisplayMessages(messages, 0, 2).map((m) => m.id)
    expect(window).toEqual(['a3', 'u2'])
  })
})

describe('resolveDisplayOrder', () => {
  it('reuses the cached id order while only the streaming content changes', () => {
    const messages = [message('u1', 'user'), message('a1', 'assistant')]
    const compute = vi.fn(computeDisplayMessages)

    const first = resolveDisplayOrder(EMPTY_DISPLAY_ORDER_CACHE, messages, 20, compute)
    expect(compute).toHaveBeenCalledTimes(1)

    // 流式 delta 的形状：数组引用换新、条数与末条 id 不变
    const streaming = [messages[0], { ...messages[1] } as Message]
    const second = resolveDisplayOrder(first, streaming, 20, compute)

    expect(compute).toHaveBeenCalledTimes(1) // 不再重排窗口
    expect(second).toBe(first)
    expect(displayOrderKey(streaming, 20)).toBe(displayOrderKey(messages, 20))
  })

  it('recomputes when a new message, another window size or another last id arrives', () => {
    const messages = [message('u1', 'user')]
    const compute = vi.fn(computeDisplayMessages)
    const first = resolveDisplayOrder(EMPTY_DISPLAY_ORDER_CACHE, messages, 20, compute)

    resolveDisplayOrder(first, [...messages, message('a1', 'assistant')], 20, compute)
    resolveDisplayOrder(first, messages, 5, compute)

    expect(compute).toHaveBeenCalledTimes(3)
  })

  /**
   * 真机回归（2026-10-01）：回合开始时用户消息的 id 从临时 id 重映射成内核 id，
   * 而"条数 / displayCount / 末条 id"三者都没变。旧实现只比 key ⇒ 缓存命中 ⇒ 缓存里的旧 id
   * 在实体表里查不到 ⇒ projectDisplayMessages 静默丢卡 ⇒ **生成期间用户消息卡片整条消失**，
   * 回合结束后才回来。所以缓存命中还必须校验缓存里的 id 都还能解析。
   */
  it('recomputes when a cached id was remapped even though the key is unchanged', () => {
    const messages = [message('temp-user', 'user'), message('stub-assistant', 'assistant', 'temp-user')]
    const compute = vi.fn(computeDisplayMessages)
    const first = resolveDisplayOrder(EMPTY_DISPLAY_ORDER_CACHE, messages, 20, compute)
    expect(compute).toHaveBeenCalledTimes(1)

    // 同一个回合内：用户消息换成内核 id，助手 stub 的 id 与条数都没变
    const remapped = [message('kernel-user', 'user'), message('stub-assistant', 'assistant', 'kernel-user')]
    const byId = new Map(remapped.map((m) => [m.id, m]))

    expect(displayOrderKey(remapped, 20)).toBe(displayOrderKey(messages, 20)) // 键确实没变
    const second = resolveDisplayOrder(first, remapped, 20, compute, byId)

    expect(compute).toHaveBeenCalledTimes(2) // 必须重算，否则旧 id 会丢卡
    expect(second.ids).toEqual(['stub-assistant', 'kernel-user'])
    expect(second.ids.every((id) => byId.has(id))).toBe(true)
  })
})

describe('projectDisplayMessages', () => {
  it('keeps the previous array when every projected entity is the same reference', () => {
    const a = message('u1', 'user')
    const b = message('a1', 'assistant')
    const previous = [b, a]
    const byId = new Map([
      ['u1', a],
      ['a1', b]
    ])

    expect(projectDisplayMessages(previous, ['a1', 'u1'], byId)).toBe(previous)
  })

  it('returns a new array when a window message entity changed (streaming must not freeze)', () => {
    const a = message('u1', 'user')
    const b = message('a1', 'assistant')
    const nextB = { ...b } as Message
    const previous = [b, a]
    const byId = new Map([
      ['u1', a],
      ['a1', nextB]
    ])

    const projected = projectDisplayMessages(previous, ['a1', 'u1'], byId)
    expect(projected).not.toBe(previous)
    expect(projected[0]).toBe(nextB)
  })

  it('drops ids that no longer exist', () => {
    const a = message('u1', 'user')
    const projected = projectDisplayMessages([a], ['u1', 'gone'], new Map([['u1', a]]))

    expect(projected).toEqual([a])
  })
})
