/**
 * `checkProviderEnabled` 抛出裸字符串。
 *
 * 缺陷形态：`throw 'Provider disabled'`（非 Error）。异常上行到 `runPainting` 的
 * `if (error instanceof Error && error.name !== 'AbortError')` 之外的 `throw error`：不分类、不打日志；
 * 再上行到 `normalizePaintingGenerateError` 时既非 `PaintingGenerateError` 也非 `Error` → 退化成
 * `GENERATE_FAILED`，用户看到的是泛化的"生成失败"（同一件事被提示两次，第二次无信息量），
 * 且栈与真实原因全部丢失。
 *
 * 行为级断言：provider 未启用时 ① 抛出的必须是 `PaintingGenerateError`；② 错误码为
 * `PROVIDER_DISABLED`（既有分类，文案键 `error.provider_disabled`），且走 toast 呈现
 * （上面的确认框已经弹过一次，不再叠一个 modal）；③ 绝不抛字符串/对象字面量。
 */
import {
  createPaintingGenerateError,
  PaintingGenerateError
} from '@renderer/pages/paintings/errors/paintingGenerateError'
import type { Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

import { checkProviderEnabled } from '../checkProviderEnabled'

const provider = { id: 'p1', name: 'Provider One', enabled: false, apiKey: 'k' } as Provider

function confirmWith(confirmed: boolean) {
  ;(window as unknown as { modal: unknown }).modal = {
    confirm: ({ onOk, onCancel }: { onOk: () => void; onCancel: () => void }) => {
      if (confirmed) onOk()
      else onCancel()
    }
  }
}

describe('checkProviderEnabled 的错误契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { navigate: unknown }).navigate = vi.fn()
  })

  it('用户取消：抛 PaintingGenerateError(PROVIDER_DISABLED)，不跳设置', async () => {
    confirmWith(false)

    const thrown = await checkProviderEnabled(provider).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toBeInstanceOf(PaintingGenerateError)
    expect((thrown as PaintingGenerateError).code).toBe('PROVIDER_DISABLED')
    expect(typeof thrown).not.toBe('string')
    expect((window as unknown as { navigate: ReturnType<typeof vi.fn> }).navigate).not.toHaveBeenCalled()
  })

  it('用户确认：跳设置页，且仍抛同一分类错误（toast 呈现，避免重复 modal）', async () => {
    confirmWith(true)

    const thrown = await checkProviderEnabled(provider).catch((error: unknown) => error)

    expect((window as unknown as { navigate: ReturnType<typeof vi.fn> }).navigate).toHaveBeenCalledWith(
      '/settings/provider?id=p1'
    )
    expect((thrown as PaintingGenerateError).code).toBe('PROVIDER_DISABLED')
    expect((thrown as PaintingGenerateError).presentation).toBe('toast')
  })

  it('provider 已启用：原样返回 apiKey（不抛）', async () => {
    await expect(checkProviderEnabled({ ...provider, enabled: true } as Provider)).resolves.toBe('k')
  })

  it('对照：裸字符串抛出不满足分类契约（旧实现的形态）', () => {
    expect(createPaintingGenerateError('PROVIDER_DISABLED')).toBeInstanceOf(PaintingGenerateError)
    // 旧实现 `throw 'Provider disabled'` 的对象既非 Error 也非 PaintingGenerateError。

    const legacy = (() => {
      try {
        throw 'Provider disabled'
      } catch (error) {
        return error
      }
    })()
    expect(legacy instanceof Error).toBe(false)
    expect(legacy instanceof PaintingGenerateError).toBe(false)
  })
})
