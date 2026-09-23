/**
 * ImageViewer 的 `preview` 契约（v0.3.3-10）：
 *   · `preview={false}`（画板 Artboard：图要 pan/zoom，不要灯箱）→ **裸 `<img>`**（V2 形态），
 *     调用方传的 `className`/`style` 必须落在 `<img>` 上——antd Image 的包裹层会把它们吃掉
 *     （rc-image 只把 COMMON_PROPS 交给 img），这正是"图片按宽度撑满 + 顶部对齐 + 被裁"的根因。
 *   · 默认（预览开启，画廊/消息里的图）→ 仍走 antd Image，以保留灯箱与分组翻页。
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ImageViewer from '../ImageViewer'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))
vi.mock('@renderer/utils/download', () => ({ download: vi.fn() }))

describe('ImageViewer · preview 契约', () => {
  it('preview={false}：渲染裸 <img>，className/style 直接落在 img 上（无 antd 包裹层）', () => {
    const { container } = render(
      <ImageViewer
        src="file:///data/Files/1a2b3c4d5e"
        alt=""
        preview={false}
        className="max-h-full max-w-full object-contain artboard-probe"
        style={{ height: 321 }}
        data-testid="artboard-image-transform"
      />
    )

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(container.querySelector('.ant-image')).toBeNull()
    expect(img?.getAttribute('src')).toBe('file:///data/Files/1a2b3c4d5e')
    expect(img?.className).toContain('object-contain')
    expect(img?.className).toContain('artboard-probe')
    expect(img?.style.height).toBe('321px')
    expect(img?.getAttribute('data-testid')).toBe('artboard-image-transform')
  })

  it('默认（预览开启）：仍是 antd Image（灯箱/分组翻页依赖它）', () => {
    const { container } = render(<ImageViewer src="https://example.com/a.png" alt="" />)

    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('.ant-image')).not.toBeNull()
  })
})
