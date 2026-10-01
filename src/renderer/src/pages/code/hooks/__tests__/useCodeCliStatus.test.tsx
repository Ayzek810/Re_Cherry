/**
 * `useCodeCliStatus` 四个同形 hook 的自持渲染环。
 *
 * 缺陷形态：effect 的依赖数组里放着调用方每次渲染都会新建的箭头函数（`getStatus` / `onStatus`），
 * 于是 effect 每次渲染都重跑——重新发一次 `getStatus()` IPC 并重新订阅；而 IPC 回来的对象引用必然与
 * 上次不同 ⇒ `setState` 每次都算变化 ⇒ 组件重渲染 ⇒ 依赖再次变化 ⇒ effect 再跑。
 *
 * 行为级断言（不是静态论证）：
 *   ① 反复重渲染 N 次，`getStatus` / `onStatus` 的调用次数都必须停在 1（依赖稳定化）；
 *   ② 内容等价的推送保持旧 state 引用（结构相等短路），不让订阅者因无变化的推送重渲染；
 *   ③ 内容变化的推送仍然生效；
 *   ④ 卸载时退订。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApiGatewayStatus, useDeepSeekHarnessStatus } from '../useCodeCliStatus'

type StatusSubscriber = (status: unknown) => void

function makeStatusBridge(initial: unknown = { status: 'stopped' }) {
  const subscribers = new Set<StatusSubscriber>()
  const getStatus = vi.fn().mockResolvedValue(initial)
  const onStatus = vi.fn((callback: StatusSubscriber) => {
    subscribers.add(callback)
    return () => subscribers.delete(callback)
  })
  const push = (status: unknown) => {
    for (const subscriber of [...subscribers]) subscriber(status)
  }
  return { getStatus, onStatus, push, subscriberCount: () => subscribers.size }
}

function installCodeCliApi(bridge: ReturnType<typeof makeStatusBridge>) {
  ;(window as unknown as { api: unknown }).api = {
    codeCli: {
      deepseekHarness: { getStatus: bridge.getStatus, onStatus: bridge.onStatus },
      apiGateway: { getStatus: bridge.getStatus, onStatus: bridge.onStatus }
    }
  }
}

describe('useCodeCliStatus（自持渲染环）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('useDeepSeekHarnessStatus：重渲染不重订阅、不重发 IPC', async () => {
    const bridge = makeStatusBridge()
    installCodeCliApi(bridge)

    const { rerender, result } = renderHook(() => useDeepSeekHarnessStatus())
    await act(async () => {})

    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
    expect(bridge.onStatus).toHaveBeenCalledTimes(1)
    expect(bridge.subscriberCount()).toBe(1)
    expect(result.current.status).toBe('stopped')

    for (let i = 0; i < 5; i += 1) rerender()
    await act(async () => {})

    // 环的另一半：若 effect 会重跑，这两个计数会随渲染次数增长。
    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
    expect(bridge.onStatus).toHaveBeenCalledTimes(1)
    expect(bridge.subscriberCount()).toBe(1)
  })

  it('useDeepSeekHarnessStatus：内容等价推送保持旧引用，内容变化推送生效', async () => {
    const bridge = makeStatusBridge()
    installCodeCliApi(bridge)

    const { result } = renderHook(() => useDeepSeekHarnessStatus())
    await act(async () => {})
    const first = result.current

    // 内容等价的新对象：旧实现必然 setState → 新引用 → 重渲染。
    await act(async () => {
      bridge.push({ status: 'stopped' })
    })
    expect(result.current).toBe(first)

    await act(async () => {
      bridge.push({ status: 'running', url: 'http://127.0.0.1:1' })
    })
    expect(result.current.status).toBe('running')
    expect(result.current).not.toBe(first)
  })

  it('useDeepSeekHarnessStatus：卸载时退订', async () => {
    const bridge = makeStatusBridge()
    installCodeCliApi(bridge)

    const { unmount } = renderHook(() => useDeepSeekHarnessStatus())
    await act(async () => {})
    expect(bridge.subscriberCount()).toBe(1)

    unmount()
    expect(bridge.subscriberCount()).toBe(0)
  })

  it('useApiGatewayStatus：重渲染不重订阅、不重发 IPC，且内容等价推送保持旧引用', async () => {
    const bridge = makeStatusBridge({ running: false })
    installCodeCliApi(bridge)

    const { rerender, result } = renderHook(() => useApiGatewayStatus())
    await act(async () => {})
    const first = result.current

    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
    expect(bridge.onStatus).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 4; i += 1) rerender()
    await act(async () => {})
    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
    expect(bridge.onStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      bridge.push({ running: false })
    })
    expect(result.current).toBe(first)

    await act(async () => {
      bridge.push({ running: true, lanRunning: true, port: 8080 })
    })
    expect(result.current.running).toBe(true)
  })
})
