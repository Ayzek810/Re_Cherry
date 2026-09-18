import EmojiIcon from '@renderer/components/EmojiIcon'
import useAssistantIdentityImage from '@renderer/hooks/useAssistantIdentityImage'
import type { Assistant } from '@renderer/types'
import { getLeadingEmoji } from '@renderer/utils'
import type { FC } from 'react'
import { useMemo } from 'react'

interface AssistantAvatarProps {
  assistant: Assistant
  size?: number
  className?: string
}

/**
 * 助手标识的统一渲染（单一路径，v0.3.1 功能一）：
 * 取值 `assistant.emoji`（库选 emoji 或 `img:` 图片引用）→ 名称首 emoji 兜底（EmojiIcon 内部再兜底 ⭐️）。
 * 左侧栏列表、话题页签、导航栏、设置弹窗标题、对话页"助手信息"挡共用本组件。
 */
const AssistantAvatar: FC<AssistantAvatarProps> = ({ assistant, size = 24, className }) => {
  const identity = useMemo(
    () => assistant.emoji || getLeadingEmoji(assistant.name || '') || '',
    [assistant.emoji, assistant.name]
  )
  const imageUrl = useAssistantIdentityImage(identity)

  if (imageUrl !== undefined) {
    return (
      <img
        className={className}
        src={imageUrl}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          objectFit: 'cover',
          flexShrink: 0,
          marginRight: 3
        }}
      />
    )
  }

  return <EmojiIcon emoji={identity} size={size} className={className} />
}

export default AssistantAvatar
