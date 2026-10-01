/**
 * v1 二轮审查 m2-04 的行为证据。
 *
 * 缺陷：网关停机链路刻意「永不 reject」（关闭失败只吞成一行 warn，超时也不再等），
 * 而 `ApiGatewayService.deactivate()` 无条件 `activated = false` 并广播「已停」——
 * 于是「开关是关的、端口是占的」。此后同端口 start() 撞 EADDRINUSE，
 * 错误信息却与网关无关，用户拿不到可行动的信号。
 *
 * 修法：关闭链路返回"是否真的关闭"（`closeServerInfo`），`ApiGateway.stop()` 把它透出，
 * `onDeactivate` 在未关闭时抛可行动错误、保留句柄与运行态广播。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type CloseableServerInfo, closeServerInfo, settledWithin } from '../serverShutdown'

const GRACE_MS = 50

/** 伪造适配器返回的 `serverInfo`：只有 stop() 与 `raw.node.server` 被关闭链消费。 */
function fakeServerInfo(options: {
  stop?: () => unknown
  listening: { value: boolean }
  closeAllConnections?: () => void
}): CloseableServerInfo {
  return {
    stop: options.stop,
    raw: {
      node: {
        server: {
          get listening() {
            return options.listening.value
          },
          ...(options.closeAllConnections ? { closeAllConnections: options.closeAllConnections } : {})
        }
      }
    }
  }
}

describe('closeServerInfo (m2-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports success when stop() settles and the listener is down', async () => {
    const listening = { value: true }
    const info = fakeServerInfo({
      stop: async () => {
        listening.value = false
      },
      listening
    })

    await expect(closeServerInfo(info, GRACE_MS)).resolves.toBe(true)
  })

  it('reports failure when stop() rejects (the port is still bound)', async () => {
    const listening = { value: true }
    const closeAllConnections = vi.fn()
    const info = fakeServerInfo({
      stop: async () => {
        throw new Error('close failed')
      },
      listening,
      closeAllConnections
    })

    await expect(closeServerInfo(info, GRACE_MS)).resolves.toBe(false)
    // 宽限期内没有 settle → 走销毁残留连接的兜底，但监听仍未解除，故仍是失败。
    expect(closeAllConnections).toHaveBeenCalled()
  })

  it('reports failure when stop() resolves but the socket is still listening', async () => {
    const listening = { value: true }
    const closeAllConnections = vi.fn()
    const info = fakeServerInfo({ stop: async () => undefined, listening, closeAllConnections })

    await expect(closeServerInfo(info, GRACE_MS)).resolves.toBe(false)
    expect(closeAllConnections).toHaveBeenCalled()
  })

  it('destroys leftover sockets and reports closed once the listener drops', async () => {
    const listening = { value: true }
    let resolveStop: (() => void) | undefined
    const closeAllConnections = vi.fn(() => {
      // 连接被销毁后监听解除、随后 stop() 才 settle（真实 SSE 长连接的收尾形态）。
      listening.value = false
      resolveStop?.()
    })
    const info = fakeServerInfo({
      stop: () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve
        }),
      listening,
      closeAllConnections
    })

    await expect(closeServerInfo(info, GRACE_MS)).resolves.toBe(true)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('is a no-op success when there is no server handle', async () => {
    await expect(closeServerInfo(null, GRACE_MS)).resolves.toBe(true)
    await expect(closeServerInfo(undefined, GRACE_MS)).resolves.toBe(true)
  })
})

describe('settledWithin', () => {
  it('resolves false on timeout without rejecting', async () => {
    await expect(settledWithin(new Promise(() => {}), 10)).resolves.toBe(false)
  })

  it('resolves true when the promise settles in time', async () => {
    await expect(settledWithin(Promise.resolve('ok'), 1000)).resolves.toBe(true)
  })
})
