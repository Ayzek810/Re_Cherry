import { useTranslation } from 'react-i18next'

import type { CustomTagProps } from '../CustomTag'
import CustomTag from '../CustomTag'

type Props = {
  size?: number
} & Omit<CustomTagProps, 'size' | 'tooltip' | 'icon' | 'color' | 'children'>

/**
 * 图像生成能力标签（v0.3.3-18）。
 *
 * **语义 = V2 的 narrow（专用 / 文生图）**：`isTextToImageModel`
 * = `IMAGE_GENERATION && !REASONING`（`cherry-studio v2/src/shared/utils/model.ts:84-86`，
 * V2 注释原话 "Dedicated / text-to-image model = IMAGE_GENERATION without REASONING"）。
 * 所以 `dall-e-*` / `gpt-image-*` / `flux-*` / `seedream-*` / `cogview*` / `qwen-image*` 带标签，
 * 而 registry 里带 `reasoning` 的 `gemini-*-image`、`gpt-5-image` **不带**。
 *
 * 形态：与 **嵌入 / 重排** 一致——同属「排他标签」组（见
 * `EditModelPopup/ModelEditContent.tsx` 的 `exclusiveTypes`），故照那两枚**只用文字当图标**、
 * 不渲染 children、不接 `showLabel`（否则 `CustomTag` 会把同一文案渲染两次）。
 */
export const ImageGenerationTag = ({ size, ...restProps }: Props) => {
  const { t } = useTranslation()
  return <CustomTag size={size} color="#eb2f96" icon={t('models.type.image_generation')} {...restProps} />
}
