/**
 * 图片 object URL 必须被 revoke。
 *
 * 原状：`compressImage` 与 `getImageInfo` 都 `URL.createObjectURL(file)` 却从不 revoke，
 * blob URL 注册表把每张处理过的图片字节留在内存里直到文档卸载；而 `compressImage` 对每张
 * 超过 1MB 的粘贴图片都会跑。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { compressImage, getImageInfo } from '../helpers/imageUtils'

const OBJECT_URL = 'blob:probe'

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 10
  height = 10
  set src(_value: string) {
    // 由测试决定何时触发 onload / onerror。
  }
}

const installImage = (behaviour: 'load' | 'error') => {
  const OriginalImage = globalThis.Image
  ;(globalThis as unknown as { Image: unknown }).Image = class extends FakeImage {
    constructor() {
      super()
      queueMicrotask(() => (behaviour === 'load' ? this.onload?.() : this.onerror?.()))
    }
  }
  return () => {
    ;(globalThis as unknown as { Image: unknown }).Image = OriginalImage
  }
}

describe('imageUtils object URL lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('revokes the object URL after a successful load in getImageInfo', async () => {
    const createObjectURL = vi.fn(() => OBJECT_URL)
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const restore = installImage('load')

    const info = await getImageInfo(new File(['x'], 'a.png', { type: 'image/png' }))

    expect(info.width).toBe(10)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL)

    restore()
  })

  it('revokes the object URL when the image fails to load', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => OBJECT_URL), revokeObjectURL })
    const restore = installImage('error')

    await expect(getImageInfo(new File(['x'], 'bad.png', { type: 'image/png' }))).rejects.toThrow()
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL)

    restore()
  })

  it('does not leak the object URL when the canvas context is unavailable', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => OBJECT_URL), revokeObjectURL })
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

    await expect(compressImage(new File(['x'], 'a.png', { type: 'image/png' }))).rejects.toThrow()
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL)

    getContext.mockRestore()
  })
})
