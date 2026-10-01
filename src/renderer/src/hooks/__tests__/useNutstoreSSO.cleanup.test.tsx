/**
 * `useNutstoreSSO` 的协议监听生命周期。
 *
 * 改动前：监听注册在 `new Promise` 里，只在收到回调的 `finally` 解绑。用户取消 SSO 或
 * 回调不来时监听器常驻、Promise 永远 pending；重复点击再叠一个监听；hook 卸载也不清理。
 *
 * 断言：整个 hook 生命周期只注册一次监听；卸载必解绑；超时/卸载/重复点击都会让在途
 * Promise 收敛（不再永久挂起）；正常回调仍然解析出 token。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNutstoreSSO } from '../useNutstoreSSO'

type ProtocolListener = (data: { url: string; params: unknown }) => void

const SSO_TIMEOUT_MS = 5 * 60 * 1000

const onReceiveData = vi.fn()
const removeListener = vi.fn()
const listeners: ProtocolListener[] = []

beforeEach(() => {
  listeners.length = 0
  onReceiveData.mockReset()
  removeListener.mockReset()
  onReceiveData.mockImplementation((listener: ProtocolListener) => {
    listeners.push(listener)
    return removeListener
  })
  ;(window as unknown as { api: unknown }).api = { protocol: { onReceiveData } }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNutstoreSSO ：监听与在途请求收敛', () => {
  it('整个生命周期只注册一个监听，卸载时解绑', () => {
    const { result, unmount } = renderHook(() => useNutstoreSSO())

    expect(onReceiveData).toHaveBeenCalledTimes(1)

    // 重复点击不叠加监听（旧实现每次调用 handler 都注册一个）
    void result.current().catch(() => {})
    void result.current().catch(() => {})
    expect(onReceiveData).toHaveBeenCalledTimes(1)

    unmount()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('收到回调时解析 token', async () => {
    const { result } = renderHook(() => useNutstoreSSO())
    const promise = result.current()

    act(() => {
      listeners[0]({ url: 'cherrystudio://nutstore?s=encrypted-token', params: {} })
    })

    await expect(promise).resolves.toBe('encrypted-token')
  })

  it('回调缺参数时按失败收敛，而不是静默 pending', async () => {
    const { result } = renderHook(() => useNutstoreSSO())
    const promise = result.current().catch((error: unknown) => error)

    act(() => {
      listeners[0]({ url: 'cherrystudio://nutstore', params: {} })
    })

    await expect(promise).resolves.toBeInstanceOf(Error)
  })

  it('超时后 reject，调用方不再永久 await', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNutstoreSSO())
    const promise = result.current().catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(SSO_TIMEOUT_MS)

    const error = await promise
    expect(String(error)).toMatch(/timed out/)
    // 监听器跟随 hook 生命周期：超时只收敛在途请求，不摘监听（否则后续 SSO 需要重新挂载）
    expect(removeListener).not.toHaveBeenCalled()
  })

  it('卸载时清理监听并让在途请求收敛', async () => {
    const { result, unmount } = renderHook(() => useNutstoreSSO())
    const promise = result.current().catch((error: unknown) => error)

    unmount()

    expect(removeListener).toHaveBeenCalledTimes(1)
    await expect(promise).resolves.toBeInstanceOf(Error)
  })
})
