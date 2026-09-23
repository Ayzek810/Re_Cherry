/**
 * 旧参数键兼容路径机测（v0.3.3 批次6，canonical 键名从 fork 自写的
 * `imageSize`/`batchSize` 统一到 V2 的 `size`/`numImages`）。
 *
 * 断言的是契约：**新键永远优先**，旧键只在 canonical 缺席时兜底，且兜底后旧键
 * 本身从袋子里消失（不会两套键同时下发）；未知键不报错。
 */
import { describe, expect, it, vi } from 'vitest'

// canonicalGenerate 的模块级依赖只做透传，测试只读 withLegacyAliases，不触发 IO。
vi.mock('@logger', () => ({ loggerService: { withContext: () => ({ error: vi.fn(), debug: vi.fn() }) } }))
vi.mock('@renderer/services/FileManager', () => ({ default: { readBinaryImage: vi.fn() } }))
vi.mock('@renderer/services/paintingImageService', () => ({
  editPaintingImages: vi.fn(),
  generatePaintingImages: vi.fn()
}))

const { withLegacyAliases } = await import('../canonicalGenerate')

describe('withLegacyAliases — 旧键 → V2 canonical 键', () => {
  it('旧键单独出现时映射到 canonical 键，且旧键被移除', () => {
    expect(withLegacyAliases({ imageSize: '512x512', batchSize: 2, negativePrompt: 'blur' })).toEqual({
      size: '512x512',
      numImages: 2,
      negativePrompt: 'blur'
    })
  })

  it('新键已存在时旧键不得覆盖（新值优先），旧键仍被清掉', () => {
    expect(withLegacyAliases({ size: '1024x1024', imageSize: '512x512' })).toEqual({ size: '1024x1024' })
    expect(withLegacyAliases({ numImages: 4, batchSize: 1 })).toEqual({ numImages: 4 })
  })

  it('旧键值为空串/undefined 时按缺席处理（不写入 canonical 键）', () => {
    expect(withLegacyAliases({ imageSize: '', batchSize: undefined })).toEqual({})
  })

  it('其它未识别键原样保留、不报错', () => {
    expect(withLegacyAliases({ prompt: 'x', mystery: true })).toEqual({ prompt: 'x', mystery: true })
  })
})
