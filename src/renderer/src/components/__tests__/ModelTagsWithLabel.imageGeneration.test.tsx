/**
 * 模型能力标签行（模型列表里那一排徽标）的生图标签契约（v0.3.3-18）。
 *
 * 断言的是"标签 = 判定结果"：**窄语义** `isTextToImageModel`（V2 的
 * `IMAGE_GENERATION && !REASONING`）为真才渲染，且文案在 DOM 里只出现一次
 * （该标签"用文字当图标"，多渲染一次 children 就会变成「生图 生图」）。
 */
import type { Model } from '@renderer/types'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ModelTagsWithLabel from '../ModelTagsWithLabel'

const textToImageMock = vi.fn()

vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: () => false,
  isFunctionCallingModel: () => false,
  isReasoningModel: () => false,
  isRerankModel: () => false,
  isTextToImageModel: (model: Model) => textToImageMock(model),
  isVisionModel: () => false,
  isWebSearchModel: () => false
}))
vi.mock('@renderer/utils/model', () => ({ isFreeModel: () => false }))
vi.mock('@renderer/i18n', () => ({ default: { language: 'zh-cn' } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const model = { id: 'm', name: 'M', provider: 'p' } as Model

/** jsdom 里 `offsetWidth` 恒 0 ⇒ 不渲染标签文字子节点；文案由 `icon`（文字当图标）承担。 */
const occurrences = (container: HTMLElement) =>
  (container.textContent?.split('models.type.image_generation').length ?? 1) - 1

describe('ModelTagsWithLabel · 生图标签', () => {
  it('专用/文生图模型：渲染一次生图标签', () => {
    textToImageMock.mockReturnValue(true)
    const { container } = render(<ModelTagsWithLabel model={model} />)

    expect(occurrences(container)).toBe(1)
  })

  it('普通对话模型（含 registry 里带 reasoning 的 gemini-*-image）：不渲染', () => {
    textToImageMock.mockReturnValue(false)
    const { container } = render(<ModelTagsWithLabel model={model} />)

    expect(occurrences(container)).toBe(0)
  })
})
