import {
  isEmbeddingModel,
  isFunctionCallingModel,
  isReasoningModel,
  isRerankModel,
  isTextToImageModel,
  isVisionModel,
  isWebSearchModel
} from '@renderer/config/models'
import type { Model } from '@renderer/types'
import { isFreeModel } from '@renderer/utils/model'
import type { FC } from 'react'
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  EmbeddingTag,
  FreeTag,
  ImageGenerationTag,
  ReasoningTag,
  RerankerTag,
  ToolsCallingTag,
  VisionTag,
  WebSearchTag
} from './Tags/Model'

interface ModelTagsProps {
  model: Model
  showFree?: boolean
  showReasoning?: boolean
  showToolsCalling?: boolean
  size?: number
  showLabel?: boolean
  showTooltip?: boolean
  style?: React.CSSProperties
}

const ModelTagsWithLabel: FC<ModelTagsProps> = ({
  model,
  showFree = true,
  showReasoning = true,
  showToolsCalling = true,
  size = 12,
  showLabel = true,
  showTooltip = true,
  style
}) => {
  const [shouldShowLabel, setShouldShowLabel] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeObserver = useRef<ResizeObserver | null>(null)
  // `i18n.language` 是可变的全局值。原来经默认单例读取且依赖数组为空，
  // 语言切换后 `maxWidth` 仍是旧值（英文标签更长，被压在 zh 的阈值下不显示），
  // 直到重启才恢复。走 `useTranslation()`，组件订阅语言变化并把它放进依赖。
  const { i18n } = useTranslation()

  const maxWidth = useMemo(() => ((i18n?.language ?? '').startsWith('zh') ? 300 : 350), [i18n?.language])

  useLayoutEffect(() => {
    const currentElement = containerRef.current
    if (!showLabel || !currentElement) return

    setShouldShowLabel(currentElement.offsetWidth >= maxWidth)

    if (currentElement) {
      resizeObserver.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width } = entry.contentRect
          setShouldShowLabel(width >= maxWidth)
        }
      })
      resizeObserver.current.observe(currentElement)
    }
    return () => {
      if (resizeObserver.current && currentElement) {
        resizeObserver.current.unobserve(currentElement)
        resizeObserver.current.disconnect()
        resizeObserver.current = null
      }
    }
  }, [maxWidth, showLabel])

  return (
    <Container ref={containerRef} style={style}>
      {isVisionModel(model) && <VisionTag size={size} showTooltip={showTooltip} showLabel={shouldShowLabel} />}
      {isWebSearchModel(model) && <WebSearchTag size={size} showTooltip={showTooltip} showLabel={shouldShowLabel} />}
      {showReasoning && isReasoningModel(model) && (
        <ReasoningTag size={size} showTooltip={showTooltip} showLabel={shouldShowLabel} />
      )}
      {showToolsCalling && isFunctionCallingModel(model) && (
        <ToolsCallingTag size={size} showTooltip={showTooltip} showLabel={shouldShowLabel} />
      )}
      {/* ：生图标签（窄语义 = V2 的专用/文生图）。与嵌入/重排同形态，只传 size。*/}
      {isTextToImageModel(model) && <ImageGenerationTag size={size} />}
      {isEmbeddingModel(model) && <EmbeddingTag size={size} />}
      {showFree && isFreeModel(model) && <FreeTag size={size} />}
      {isRerankModel(model) && <RerankerTag size={size} />}
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  overflow-x: scroll;
  &::-webkit-scrollbar {
    display: none;
  }
`

export default memo(ModelTagsWithLabel)
