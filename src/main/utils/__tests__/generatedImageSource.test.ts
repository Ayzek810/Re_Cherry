/**
 * 生成图源串解析（v0.3.3-2 聊天页出图落盘）。
 *
 * 轻量图像平面返回的 `images[]` 有三种形态：data URL、裸 base64（`b64_json`）、http(s) URL。
 * 这里钉住"三种都认、认不出就返回 undefined（不猜）"——真机上吃过的亏是后缀/类型判错导致
 * 图进了库却在文件页看不到。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userData') }
}))
vi.mock('uuid', () => ({ v4: () => 'mock-uuid' }))

import { parseGeneratedImageSource } from '../file'

describe('parseGeneratedImageSource', () => {
  it('data URL：取出媒体类型与裸 base64', () => {
    const parsed = parseGeneratedImageSource('data:image/webp;base64,aGVsbG8=')
    expect(parsed).toEqual({ kind: 'dataUrl', mediaType: 'image/webp', base64: 'aGVsbG8=' })
  })

  it('http(s) URL：按 url 形态返回（下载交给主进程 net.fetch）', () => {
    expect(parseGeneratedImageSource('https://cdn.example.com/a/b.png?sig=1')).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/a/b.png?sig=1'
    })
  })

  it('裸 base64（b64_json）：够长且字符合法才收', () => {
    const base64 = 'A'.repeat(80)
    expect(parseGeneratedImageSource(base64)).toEqual({ kind: 'base64', base64 })
    // 太短（可能是错误文案碎片）不收
    expect(parseGeneratedImageSource('A'.repeat(20))).toBeUndefined()
  })

  it('认不出的一律 undefined：空串、错误文案、坏 data URL', () => {
    expect(parseGeneratedImageSource('')).toBeUndefined()
    expect(parseGeneratedImageSource('   ')).toBeUndefined()
    expect(parseGeneratedImageSource('生成失败：额度不足，请稍后再试')).toBeUndefined()
    expect(parseGeneratedImageSource('data:image/png;base64,')).toBeUndefined()
  })
})
