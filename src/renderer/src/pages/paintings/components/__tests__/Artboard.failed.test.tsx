/**
 * 二轮审查 f2-23：`generationError` 只写不读——回到一幅失败的画作时画板全空且无任何解释。
 *
 * 缺陷形态：失败路径把错误写进 `PaintingData.generationError`（并镜像进会话），但全 paintings 目录
 * 只有类型声明、状态投影与写入点，**没有任何读取/渲染**；画板的占位分支只看 `generationStatus`。
 * 失败当刻的 modal/toast 是唯一信号，切走再回来后用户看到的是一块空占位、没有失败说明，
 * 也看不到错误详情（§9 静默不可见）。
 *
 * 行为级断言：无图 + `generationStatus==='failed'` → 渲染失败说明 + 底层错误详情；
 * 同一条画在 `running` 之外的成功态（无状态无文件）仍然走原占位，不被这条新分支吃掉。
 */
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { render } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

// 真实 i18n（语言锁定 en-US，断言用英文文案；旧实现里 `t('paintings.generate_failed')`
// 在画板上根本不存在读取者，所以这些断言在旧实现下找不到节点）。
Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })

vi.mock('@renderer/pages/paintings/utils/paintingFileUrl', () => ({
  getPaintingFileUrl: (file: { id: string }) => `file:///painting/${file.id}.png`
}))

vi.mock('@renderer/pages/paintings/utils/computeImageNaturalSize', () => ({
  computeImageNaturalSize: vi.fn(async () => null)
}))

vi.mock('@renderer/pages/paintings/components/PaintingImageSkeleton', () => ({
  default: () => <div data-testid="skeleton" />
}))

vi.mock('@renderer/pages/paintings/hooks/usePaintingSizeInfo', () => ({
  usePaintingSizeInfo: () => ({ sizeLabel: '1024x1024' })
}))

// 图片视图替身：只暴露"有没有渲染图片分支"这一观察点。
vi.mock('@renderer/components/ImageViewer', () => ({
  default: ({ src }: { src?: string }) => <img data-testid="artboard-image-transform" src={src} alt="" />
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import '@renderer/i18n'

import Artboard from '../Artboard'

const painting = (overrides: Partial<PaintingData>): PaintingData =>
  ({
    id: 'p-1',
    providerId: 'prov-1',
    mode: 'generate',
    model: 'm-1',
    prompt: 'a cat',
    files: [],
    ...overrides
  }) as PaintingData

describe('Artboard 失败态（f2-23）', () => {
  it('失败且无图：渲染失败说明与底层错误详情', () => {
    const { container } = render(
      <Artboard
        painting={painting({ generationStatus: 'failed', generationError: 'quota exceeded' })}
        isLoading={false}
      />
    )

    const failed = container.querySelector('[data-testid="artboard-generation-failed"]')
    expect(failed).not.toBeNull()
    expect(failed?.textContent).toContain('Generation failed')
    expect(failed?.textContent).toContain('quota exceeded')
    expect(failed?.querySelector('[title="quota exceeded"]')).not.toBeNull()
  })

  it('取消且无图：渲染取消说明（不是空占位）', () => {
    const { container } = render(<Artboard painting={painting({ generationStatus: 'canceled' })} isLoading={false} />)

    const failed = container.querySelector('[data-testid="artboard-generation-failed"]')
    expect(failed).not.toBeNull()
    expect(failed?.textContent).toContain('Generation canceled')
    expect(failed?.textContent).not.toContain('quota exceeded')
  })

  it('失败但已有图：仍然展示图片（失败态不覆盖已有结果）', () => {
    const { container } = render(
      <Artboard
        painting={painting({
          generationStatus: 'failed',
          generationError: 'boom',
          files: [{ id: 'f-1', origin_name: 'f-1.png' }] as PaintingData['files']
        })}
        isLoading={false}
      />
    )

    expect(container.querySelector('[data-testid="artboard-image-transform"]')).not.toBeNull()
  })
})
