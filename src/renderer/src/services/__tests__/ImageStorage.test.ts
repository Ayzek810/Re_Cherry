/**
 * 二轮审查 r2-08 / r2-54：图片存储的写与读。
 *
 * r2-08：`set()` 的 update 分支是 `void db.settings.update(...)`——既不 await 也不 catch。
 * 后置读回（三个调用点都用 `await ImageStorage.get(...)` 的结果设置 UI）因此读到旧值，
 * 写失败则变成 unhandled rejection。现在两支统一为一个 awaited `put`（upsert）。
 *
 * r2-54：`get()` 签名承诺 `string`，无记录时却返回 `undefined`，undefined 会漏进
 * `setState`/渲染。现在归一化为 `''`。
 *
 * 行为级断言：
 *   ① 写走单支 `put`（不再 add/update 分叉）；
 *   ② `set()` 必须等落库完成才 resolve（写后读回一定看到新值）；
 *   ③ 无记录时 `get()` 返回空串，不是 undefined；
 *   ④ 写失败必须有可见信号（toast.error）且不得静默。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { put, add, update, getRecord, deleteRecord, convertToBase64, toastError } = vi.hoisted(() => ({
  put: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  getRecord: vi.fn(),
  deleteRecord: vi.fn(),
  convertToBase64: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    settings: {
      put,
      add,
      update,
      get: getRecord,
      delete: deleteRecord
    }
  }
}))

vi.mock('@renderer/utils', () => ({ convertToBase64 }))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }
}))

import ImageStorage from '../ImageStorage'

describe('ImageStorage 写入/读取语义（r2-08 / r2-54）', () => {
  beforeEach(() => {
    put.mockReset()
    add.mockReset()
    update.mockReset()
    getRecord.mockReset()
    deleteRecord.mockReset()
    convertToBase64.mockReset()
    toastError.mockReset()
    put.mockResolvedValue(undefined)
    ;(window as unknown as { toast: unknown }).toast = { error: toastError, warning: vi.fn(), info: vi.fn() }
  })

  it('已有记录时也走 upsert（put），不再 add/update 分叉', async () => {
    getRecord.mockResolvedValue({ id: 'image://avatar', value: 'old' })

    await ImageStorage.set('avatar', 'new')

    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith({ id: 'image://avatar', value: 'new' })
    expect(add).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('set() 等落库完成才 resolve（旧实现 void update 会提前 resolve）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    put.mockReturnValue(gate)

    let settled = false
    const pending = ImageStorage.set('avatar', 'new').then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await pending
    expect(settled).toBe(true)
  })

  it('写后读回看到新值（三个调用点的「保存后立刻 get」模式）', async () => {
    const store = new Map<string, { id: string; value: string }>()
    put.mockImplementation(async (record: { id: string; value: string }) => {
      store.set(record.id, record)
    })
    getRecord.mockImplementation(async (id: string) => store.get(id))

    await ImageStorage.set('avatar', 'fresh')
    await expect(ImageStorage.get('avatar')).resolves.toBe('fresh')
  })

  it('文件图片同样走 put（await convertToBase64 之后）', async () => {
    convertToBase64.mockResolvedValue('data:image/png;base64,AAA')

    await ImageStorage.set('provider-1', new File(['x'], 'logo.png'))

    expect(put).toHaveBeenCalledWith({ id: 'image://provider-1', value: 'data:image/png;base64,AAA' })
  })

  it('无记录时 get() 返回空串（r2-54：不再是 undefined）', async () => {
    getRecord.mockResolvedValue(undefined)

    const value = await ImageStorage.get('missing')

    expect(value).toBe('')
    expect(typeof value).toBe('string')
  })

  it('写失败：不静默，弹可见错误（且不产生未处理拒绝）', async () => {
    put.mockRejectedValue(new Error('quota exceeded'))

    await expect(ImageStorage.set('avatar', 'new')).resolves.toBeUndefined()

    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
