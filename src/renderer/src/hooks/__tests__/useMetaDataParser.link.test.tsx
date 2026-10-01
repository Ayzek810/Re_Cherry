/**
 * `useMetaDataParser` 的解析门槛与 link 归属。
 *
 * 改动前：`parseMetadata` 的 guard 是 `if (!link || !isLoading) return`，消费方
 * （`OGCard`）的门槛是 `if (show && isLoading)`。首次解析完成后 `isLoading === false`，
 * 两者同时恒假 ⇒ 换 link 也不会再解析；`metadata` 又从不随 link 复位 ⇒
 * 「新 hostname + 旧 og:title」的过期数据被当成有效结果展示。
 *
 * 断言：同一 link 幂等、link 变化后必须能再次解析、非 current link 的元数据/错误
 * 一律不回传、迟到响应不得覆盖新 link 的结果、失败必须以 error 呈现（不伪装成空结果）。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock, isCancelMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  isCancelMock: vi.fn(() => false)
}))

vi.mock('axios', () => ({
  default: { get: getMock, isCancel: isCancelMock },
  isCancel: isCancelMock
}))

import { useMetaDataParser } from '../useMetaDataParser'

const OPEN_GRAPH = ['og:title'] as const

const htmlWithTitle = (title: string) =>
  `<html><head><meta property="og:title" content="${title}"/></head><body></body></html>`

beforeEach(() => {
  getMock.mockReset()
  isCancelMock.mockReset()
  isCancelMock.mockReturnValue(false)
})

describe('useMetaDataParser ：link 归属与可重解析', () => {
  it('首次解析后仍能解析新 link，且不展示旧 link 的元数据', async () => {
    getMock.mockResolvedValueOnce({ data: htmlWithTitle('A 标题') })

    const { result, rerender } = renderHook(({ link }: { link: string }) => useMetaDataParser(link, OPEN_GRAPH), {
      initialProps: { link: 'https://a.example.com' }
    })

    // 消费方门槛（OGCard）：show && isLoading
    expect(result.current.isLoading).toBe(true)
    await act(async () => {
      await result.current.parseMetadata()
    })
    expect(result.current.metadata['og:title']).toBe('A 标题')
    expect(result.current.isLoading).toBe(false)

    getMock.mockResolvedValueOnce({ data: htmlWithTitle('B 标题') })
    rerender({ link: 'https://b.example.com' })

    // link 变了：旧 link 的元数据不得当作新 link 的结果
    expect(result.current.metadata['og:title']).toBeUndefined()
    // isLoading 复位，消费方门槛重新成立
    expect(result.current.isLoading).toBe(true)

    // 旧实现在这里恒空转（guard 依赖 isLoading）
    await act(async () => {
      await result.current.parseMetadata()
    })
    expect(result.current.metadata['og:title']).toBe('B 标题')
    expect(getMock).toHaveBeenCalledTimes(2)
    expect(getMock).toHaveBeenLastCalledWith('https://b.example.com', expect.anything())
  })

  it('迟到的旧 link 响应不得覆盖新 link 的结果', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    getMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )

    const { result, rerender } = renderHook(({ link }: { link: string }) => useMetaDataParser(link, OPEN_GRAPH), {
      initialProps: { link: 'https://old.example.com' }
    })

    await act(async () => {
      void result.current.parseMetadata()
    })

    getMock.mockResolvedValueOnce({ data: htmlWithTitle('新 标题') })
    rerender({ link: 'https://new.example.com' })
    await act(async () => {
      await result.current.parseMetadata()
    })
    expect(result.current.metadata['og:title']).toBe('新 标题')

    // 旧请求迟到（mock 的 axios 忽略 abort signal）
    await act(async () => {
      resolveOld({ data: htmlWithTitle('旧 标题') })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.metadata['og:title']).toBe('新 标题')
  })

  it('解析失败时置 error 且元数据为空（失败不伪装成空结果）', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useMetaDataParser('https://fail.example.com', OPEN_GRAPH))

    await act(async () => {
      await result.current.parseMetadata()
    })

    expect(result.current.error?.message).toBe('boom')
    expect(result.current.metadata['og:title']).toBeUndefined()
    expect(result.current.isLoading).toBe(false)
  })
})
