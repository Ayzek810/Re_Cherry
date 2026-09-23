/**
 * 参考图托盘（`PaintingInputTray`）的灯箱契约测试。
 *
 * 行为级验证（§4.18）：V2 `pages/paintings/components/PaintingImageGallery.tsx:104-110`
 * 点缩略图开大图并可左右翻页。fork 曾经是 `preview={false}` —— 缩略图完全点不开（P1），
 * 本测试钉住「托盘里的缩略图都在同一个成组灯箱内、且每张自身的预览是开着的」这条配对契约：
 * 组内注册是 antd 翻页的充要条件，任何一张漏进组或 preview 被关掉都会在这里红。
 */
import type { FileMetadata } from '@renderer/types'
import { fireEvent, render } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { PaintingInputTray } from '../PaintingImageGallery'

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

vi.mock('@renderer/pages/paintings/utils/paintingFileUrl', () => ({
  getPaintingFileUrl: (file: { id: string }) => `file:///painting/${file.id}.png`
}))

vi.mock('@renderer/components/HorizontalScrollContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="hscroll">{children}</div>
}))

// fork 的 ImageViewer 是 antd Image 的薄包装（复制/下载右键菜单 + 工具栏）；灯箱归属由
// 外层的 Image.PreviewGroup 决定，故这里只用替身记录「拿到的是哪张图、preview 是否开着」。
vi.mock('@renderer/components/ImageViewer', () => ({
  default: ({ src, alt, preview }: { src: string; alt?: string; preview?: unknown }) => (
    <span data-testid="viewer" data-src={src} data-alt={alt} data-preview={preview === false ? 'off' : 'on'} />
  )
}))

// 组灯箱替身：真 antd PreviewGroup 会注册组内每张图；测试只需知道"谁在组里"。
vi.mock('antd', () => ({
  Image: {
    PreviewGroup: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="preview-group">{children}</div>
    )
  },
  Button: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

vi.mock('lucide-react', () => ({ X: () => <span data-testid="remove-icon" /> }))

const file = (id: string, origin_name = `${id}.png`): FileMetadata =>
  ({
    id,
    name: origin_name,
    origin_name,
    path: `/tmp/${origin_name}`,
    size: 1,
    ext: '.png',
    type: 'image',
    created_at: '',
    count: 1
  }) as FileMetadata

describe('PaintingInputTray 参考图灯箱', () => {
  it('两张参考图都在同一个灯箱组里，且每张自己的预览都开着（可点开 + 左右翻页）', () => {
    const { container } = render(<PaintingInputTray files={[file('a'), file('b')]} onRemove={vi.fn()} />)

    const group = container.querySelector('[data-testid="preview-group"]')
    expect(group).not.toBeNull()

    const viewers = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="viewer"]'))
    expect(viewers).toHaveLength(2)
    expect(viewers.map((element) => element.dataset.src)).toEqual([
      'file:///painting/a.png',
      'file:///painting/b.png'
    ])
    // 每张都必须既"开着预览"又"在组内"——缺任一条都点不开大图。
    for (const viewer of viewers) {
      expect(viewer.dataset.preview).toBe('on')
      expect(group?.contains(viewer)).toBe(true)
    }
  })

  it('单张参考图也在灯箱组里（点击即开大图）', () => {
    const { container } = render(<PaintingInputTray files={[file('only')]} onRemove={vi.fn()} />)
    const group = container.querySelector('[data-testid="preview-group"]')
    const viewer = container.querySelector<HTMLElement>('[data-testid="viewer"]')
    expect(viewer?.dataset.preview).toBe('on')
    expect(group?.contains(viewer ?? null)).toBe(true)
  })

  it('点击删除按钮只移除该张', () => {
    const onRemove = vi.fn()
    const { container } = render(<PaintingInputTray files={[file('a'), file('b')]} onRemove={onRemove} />)

    const removeButton = container.querySelectorAll('button')
    expect(removeButton).toHaveLength(2)
    fireEvent.click(removeButton[1])
    expect(onRemove).toHaveBeenCalledWith('b')
  })

  it('没有参考图时不渲染托盘', () => {
    const { container } = render(<PaintingInputTray files={[]} onRemove={vi.fn()} />)
    expect(container.querySelector('[data-testid="hscroll"]')).toBeNull()
  })
})
