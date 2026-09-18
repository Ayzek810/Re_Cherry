import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import { HStack } from '@renderer/components/Layout'
import UserPopup from '@renderer/components/Popups/UserPopup'
import { APP_NAME, AppLogo, isLocalAi } from '@renderer/config/env'
import { getModelLogoById } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMessageStyle, useSettings } from '@renderer/hooks/useSettings'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelName } from '@renderer/services/ModelService'
import type { Assistant, Model, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { firstLetter, isEmoji, removeLeadingEmoji } from '@renderer/utils'
import { Avatar, Checkbox, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { Sparkle } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  message: Message
  assistant: Assistant
  model?: Model
  topic: Topic
  isGroupContextMessage?: boolean
}

const getAvatarSource = (isLocalAi: boolean, modelId: string | undefined) => {
  if (isLocalAi) return AppLogo
  return modelId ? getModelLogoById(modelId) : undefined
}

const MessageHeader: FC<Props> = memo(({ assistant, model, message, topic, isGroupContextMessage }) => {
  const avatar = useAvatar()
  const { theme } = useTheme()
  const { userName, sidebarIcons } = useSettings()
  const { t } = useTranslation()
  const { isBubbleStyle } = useMessageStyle()
  const { openMinappById } = useMinappPopup()

  const { isMultiSelectMode, selectedMessageIds, handleSelectMessage } = useChatContext(topic)

  const isSelected = selectedMessageIds?.includes(message.id)

  const isAssistantMessage = message.role === 'assistant'
  const isUserMessage = message.role === 'user'
  const isUserBubbleMessage = isBubbleStyle && isUserMessage && !isMultiSelectMode
  const showMinappIcon = sidebarIcons.visible.includes('minapp')

  /**
   * 功能二（v0.3.1）：助手级显示挡位 —— 'assistant' 时 AI 行展示助手标识与助手名，
   * 模型名退到时间戳小字右侧；缺省 'model' 保持原版模型头像 + 模型名。
   */
  const isAssistantIdentityMode =
    isAssistantMessage && (assistant?.settings?.messageIdentity ?? 'model') === 'assistant'

  const avatarSource = useMemo(() => getAvatarSource(isLocalAi, getMessageModelId(message)), [message])

  const getUserName = useCallback(() => {
    if (isAssistantMessage) {
      // 助手信息挡：标题改为助手名（剥掉名称首 emoji，头像已是标识）
      if (isAssistantIdentityMode) {
        return removeLeadingEmoji(assistant?.name ?? '') || t('chat.default.name')
      }
      if (isLocalAi) {
        return APP_NAME
      }
      return getModelName(model) || getMessageModelId(message) || ''
    }

    return userName || t('common.you')
  }, [isAssistantMessage, isAssistantIdentityMode, assistant, model, message, t, userName])

  const avatarName = useMemo(() => firstLetter(assistant?.name).toUpperCase(), [assistant?.name])
  const username = useMemo(() => removeLeadingEmoji(getUserName()), [getUserName])

  const showMiniApp = useCallback(() => {
    showMinappIcon && model?.provider && openMinappById(model.provider)
    // because don't need openMinappById to be a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.provider, showMinappIcon])

  const userNameJustifyContent = useMemo(() => {
    if (!isBubbleStyle) return 'flex-start'
    if (isUserMessage && !isMultiSelectMode) return 'flex-end'
    return 'flex-start'
  }, [isBubbleStyle, isUserMessage, isMultiSelectMode])

  return (
    <Container className={isUserBubbleMessage ? 'message-header user-bubble-header' : 'message-header'}>
      {isAssistantMessage ? (
        isAssistantIdentityMode ? (
          <AssistantAvatar assistant={assistant} size={35} />
        ) : (
          <Avatar
            src={avatarSource}
            size={35}
            style={{
              borderRadius: '25%',
              cursor: showMinappIcon ? 'pointer' : 'default',
              border: isLocalAi ? '1px solid var(--color-border-soft)' : 'none',
              filter: theme === 'dark' ? 'invert(0.05)' : undefined
            }}
            onClick={showMiniApp}>
            {avatarName}
          </Avatar>
        )
      ) : (
        <>
          {isEmoji(avatar) ? (
            <EmojiAvatar onClick={() => UserPopup.show()} size={35} fontSize={20}>
              {avatar}
            </EmojiAvatar>
          ) : (
            <Avatar
              src={avatar}
              size={35}
              style={{ borderRadius: '25%', cursor: 'pointer' }}
              onClick={() => UserPopup.show()}
            />
          )}
        </>
      )}
      {!isUserBubbleMessage && (
        <UserWrap>
          <HStack alignItems="center" justifyContent={userNameJustifyContent}>
            <UserName isBubbleStyle={isBubbleStyle && isUserMessage} theme={theme}>
              {username}
            </UserName>
            {isGroupContextMessage && (
              <Tooltip title={t('chat.message.useful.tip')}>
                <Sparkle fill="var(--color-primary)" strokeWidth={0} size={18} />
              </Tooltip>
            )}
          </HStack>
          <InfoWrap className="message-header-info-wrap text-(--color-text-3) text-[10px]">
            <MessageTime>{dayjs(message?.updatedAt ?? message.createdAt).format('MM/DD HH:mm')}</MessageTime>
            {isAssistantIdentityMode && (
              <MessageModelName>{getModelName(model) || getMessageModelId(message) || ''}</MessageModelName>
            )}
          </InfoWrap>
        </UserWrap>
      )}
      {isMultiSelectMode && (
        <Checkbox
          checked={isSelected}
          onChange={(e) => handleSelectMessage(message.id, e.target.checked)}
          style={{ position: 'absolute', right: 0, top: 0 }}
        />
      )}
    </Container>
  )
})

MessageHeader.displayName = 'MessageHeader'

const Container = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  position: relative;
  margin-bottom: 10px;
`

const UserWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  flex: 1;
`

const InfoWrap = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
`

const UserName = styled.span<{ isBubbleStyle?: boolean; theme?: string }>`
  font-size: 14px;
  font-weight: 600;
  color: ${(props) => (props.isBubbleStyle && props.theme === 'dark' ? 'white' : 'var(--color-text)')};
`

const MessageTime = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
`

/** 助手信息挡：模型名显示在时间戳右侧的小字 */
const MessageModelName = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export default MessageHeader
