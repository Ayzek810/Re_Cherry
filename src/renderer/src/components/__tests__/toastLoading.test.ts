/**
 * c2-28 行为测试：`loading` toast 的默认文案必须过 i18next，且失败要收口。
 *
 * 原状：四个默认串（`Loading...` / `Success` / `Error` / `An error occurred`）绕过 i18next，
 * 中文界面下直接显示英文；`loading()` 把 `promise.then(...).catch(...)` 的链**丢弃**，
 * `.catch` 里 `throw err` 之后无人再 catch —— 失败变成 unhandled rejection，调用方也拿不到收口。
 */
import i18n from '@renderer/i18n'
import type { MessageInstance } from 'antd/es/message/interface'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initMessageApi, loading } from '../TopView/toast'

const createApi = () => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  open: vi.fn(),
  destroy: vi.fn()
})

describe('toast.loading (c2-28)', () => {
  let api: ReturnType<typeof createApi>

  beforeEach(() => {
    api = createApi()
    initMessageApi(api as unknown as MessageInstance)
    ;(window as unknown as { toast: unknown }).toast = { error: vi.fn() }
  })

  it('uses the i18n defaults instead of hardcoded English', async () => {
    await loading({ promise: Promise.resolve('ok') })

    const loadingContent = api.loading.mock.calls[0][0].content
    const successContent = api.success.mock.calls[0][0].content

    // 文案取自 i18next（未走 i18n 时四串默认值必然是英文常量）。
    expect(loadingContent.props.title).toBe(i18n.t('common.loading'))
    expect(successContent.props.title).toBe(i18n.t('common.success'))
  })

  it('resolves instead of rethrowing when the underlying promise fails', async () => {
    const result = await loading({ promise: Promise.reject(new Error('boom')) })

    expect(result).toBeUndefined()
    expect(api.error).toHaveBeenCalledTimes(1)
    const errorContent = api.error.mock.calls[0][0].content
    expect(errorContent.props.title).toBe(i18n.t('common.error'))
    expect(errorContent.props.description).toBe('boom')
  })
})
