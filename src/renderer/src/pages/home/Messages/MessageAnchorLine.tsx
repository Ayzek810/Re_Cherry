import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import { APP_NAME, AppLogo, isLocalAi } from '@renderer/config/env'
import { getModelLogoById } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelName } from '@renderer/services/ModelService'
import { useAppDispatch } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
// import { updateMessageThunk } from '@renderer/store/thunk/messageThunk'
import type { Message } from '@renderer/types/newMessage'
import { isEmoji, removeLeadingEmoji } from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { Avatar } from 'antd'
import { CircleChevronDown } from 'lucide-react'
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { scrollMessagesToBottom } from './shared'

interface MessageLineProps {
  messages: Message[]
}

const getAvatarSource = (isLocalAi: boolean, modelId: string | undefined) => {
  if (isLocalAi) return AppLogo
  return modelId ? getModelLogoById(modelId) : undefined
}

interface AnchorDistanceValues {
  opacity: number
  scale: number
  size: number
}

const MessageAnchorLine: FC<MessageLineProps> = ({ messages }) => {
  const { t } = useTranslation()
  const avatar = useAvatar()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const { userName } = useSettings()
  const { setTimeoutTimer } = useTimer()

  const messagesListRef = useRef<HTMLDivElement>(null)
  const messageItemsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  const [mouseY, setMouseY] = useState<number | null>(null)
  const [listOffsetY, setListOffsetY] = useState(0)
  const [containerHeight, setContainerHeight] = useState<number | null>(null)

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const parentElement = containerRef.current.parentElement
        if (parentElement) {
          setContainerHeight(parentElement.clientHeight)
        }
      }
    }

    updateHeight()
    window.addEventListener('resize', updateHeight)

    return () => {
      window.removeEventListener('resize', updateHeight)
    }
  }, [messages])

  // 函数用于计算根据距离的变化值
  const calculateValueByDistance = useCallback(
    (itemId: string, maxValue: number) => {
      if (mouseY === null) return 0

      const element = messageItemsRef.current.get(itemId)
      if (!element) return 0

      const rect = element.getBoundingClientRect()
      const centerY = rect.top + rect.height / 2
      const distance = Math.abs(centerY - (messagesListRef.current?.getBoundingClientRect().top || 0) - mouseY)
      const maxDistance = 100

      return Math.max(0, maxValue * (1 - distance / maxDistance))
    },
    [mouseY]
  )

  // hover 态的距离量按 [mouseY, 条数] 缓存：calculateValueByDistance 每次读 getBoundingClientRect，
  // 流式期间 messages 每帧换引用会把 N 次强制布局重复做一遍（旧实现的 layout thrash）。
  // 非 hover 态完全不读 DOM —— calculateValueByDistance 本身在 mouseY === null 时早退。
  const distanceCacheRef = useRef<{ key: string; values: Map<string, AnchorDistanceValues> } | null>(null)
  const distanceValues = useMemo(() => {
    if (mouseY === null) return null

    const key = `${mouseY}|${messages.length}`
    if (distanceCacheRef.current?.key === key) return distanceCacheRef.current.values

    const values = new Map<string, AnchorDistanceValues>()
    for (const id of ['bottom-anchor', ...messages.map((message) => message.id)]) {
      values.set(id, {
        opacity: 0.5 + calculateValueByDistance(id, 1),
        scale: 1 + calculateValueByDistance(id, 1.2),
        size: 10 + calculateValueByDistance(id, 20)
      })
    }
    distanceCacheRef.current = { key, values }
    return values
  }, [mouseY, messages, calculateValueByDistance])

  const getUserName = useCallback(
    (message: Message) => {
      if (isLocalAi && message.role !== 'user') {
        return APP_NAME
      }

      if (message.role === 'assistant') {
        if (message.model) {
          return getModelName(message.model) || message.model.name || message.modelId || ''
        }

        const modelId = getMessageModelId(message)
        return modelId || ''
      }

      return userName || t('common.you')
    },
    [userName, t]
  )

  const setSelectedMessage = useCallback(
    (message: Message) => {
      const groupMessages = messages.filter((m) => m.askId === message.askId)
      if (groupMessages.length > 1) {
        for (const m of groupMessages) {
          dispatch(
            newMessagesActions.updateMessage({
              topicId: m.topicId,
              messageId: m.id,
              updates: { foldSelected: m.id === message.id }
            })
          )
        }

        setTimeoutTimer(
          'setSelectedMessage',
          () => {
            const messageElement = document.getElementById(`message-${message.id}`)
            if (messageElement) {
              scrollIntoView(messageElement, { behavior: 'auto', block: 'start', container: 'nearest' })
            }
          },
          100
        )
      }
    },
    [dispatch, messages, setTimeoutTimer]
  )

  const scrollToMessage = useCallback(
    (message: Message) => {
      const messageElement = document.getElementById(`message-${message.id}`)

      if (!messageElement) return

      const display = messageElement ? window.getComputedStyle(messageElement).display : null
      if (display === 'none') {
        setSelectedMessage(message)
        return
      }

      scrollIntoView(messageElement, { behavior: 'smooth', block: 'start', container: 'nearest' })
    },
    [setSelectedMessage]
  )

  // 回到底部：`#messages` 是 column-reverse，坐标语义由 shared.scrollMessagesToBottom 单点承载
  const scrollToBottom = useCallback(() => {
    scrollMessagesToBottom(document.getElementById('messages'))
  }, [])

  // onSelect 必须稳定：scrollToMessage 的依赖含 messages，逐 delta 换引用会让 memo 子项全部失效
  const scrollToMessageRef = useRef(scrollToMessage)
  useEffect(() => {
    scrollToMessageRef.current = scrollToMessage
  }, [scrollToMessage])
  const handleSelectMessage = useCallback((message: Message) => {
    scrollToMessageRef.current(message)
  }, [])

  const registerMessageItem = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) messageItemsRef.current.set(id, element)
    else messageItemsRef.current.delete(id)
  }, [])

  if (messages.length === 0) return null

  const handleMouseMove = (e: React.MouseEvent) => {
    if (messagesListRef.current) {
      const containerRect = e.currentTarget.getBoundingClientRect()
      const listRect = messagesListRef.current.getBoundingClientRect()
      setMouseY(e.clientY - listRect.top)

      if (listRect.height > containerRect.height) {
        const mousePositionRatio = (e.clientY - containerRect.top) / containerRect.height
        const maxOffset = (containerRect.height - listRect.height) / 2 - 20
        setListOffsetY(-maxOffset + mousePositionRatio * (maxOffset * 2))
      } else {
        setListOffsetY(0)
      }
    }
  }

  const handleMouseLeave = () => {
    setMouseY(null)
    setListOffsetY(0)
  }

  return (
    <MessageLineContainer
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      $height={containerHeight}>
      <MessagesList ref={messagesListRef} style={{ transform: `translateY(${listOffsetY}px)` }}>
        <MessageItem
          key="bottom-anchor"
          ref={(el) => {
            if (el) messageItemsRef.current.set('bottom-anchor', el)
            else messageItemsRef.current.delete('bottom-anchor')
          }}
          style={{
            opacity: mouseY ? 0.5 : Math.max(0, 0.6 - (0.3 * Math.abs(0 - messages.length / 2)) / 5)
          }}
          onClick={scrollToBottom}>
          <CircleChevronDown
            size={distanceValues?.get('bottom-anchor')?.size ?? 10}
            style={{ color: theme === 'dark' ? 'var(--color-text)' : 'var(--color-primary)' }}
          />
        </MessageItem>
        {messages.map((message, index) => {
          if (message.type === 'clear') return null

          // 非 hover 态的三个量只由 index / 条数决定（不读 DOM）；hover 态才按距离取值。
          // 以原语 prop 交给 memo 子项：流式期间未变化的条目 props 全等，React 跳过它们的重渲染。
          const distance = distanceValues?.get(message.id)
          const opacity = mouseY
            ? (distance?.opacity ?? 0.5)
            : Math.max(0, 0.6 - (0.3 * Math.abs(index - messages.length / 2)) / 5)
          const scale = distance?.scale ?? 1
          const size = distance?.size ?? 10

          return (
            <MessageAnchorItem
              key={message.id}
              message={message}
              opacity={opacity}
              scale={scale}
              size={size}
              avatar={avatar}
              theme={theme}
              getUserName={getUserName}
              onSelect={handleSelectMessage}
              registerElement={registerMessageItem}
            />
          )
        })}
      </MessagesList>
    </MessageLineContainer>
  )
}

interface AnchorItemProps {
  message: Message
  opacity: number
  scale: number
  size: number
  avatar: string
  theme: string
  getUserName: (message: Message) => string
  onSelect: (message: Message) => void
  registerElement: (id: string, element: HTMLDivElement | null) => void
}

/**
 * 单条锚点项。props 全是原语/稳定引用：流式期间未变化的条目被 memo 直接跳过重渲染
 * （旧实现整条锚点线每个 delta 全量重建，并对每项重算 getMainTextContent）。
 */
const MessageAnchorItem: FC<AnchorItemProps> = memo(
  ({ message, opacity, scale, size, avatar, theme, getUserName, onSelect, registerElement }) => {
    const avatarSource = getAvatarSource(isLocalAi, getMessageModelId(message))
    const username = removeLeadingEmoji(getUserName(message))
    const content = getMainTextContent(message)
    const setItemRef = useCallback(
      (element: HTMLDivElement | null) => registerElement(message.id, element),
      [registerElement, message.id]
    )

    return (
      <MessageItem style={{ opacity }} ref={setItemRef} onClick={() => onSelect(message)}>
        <MessageItemContainer style={{ transform: ` scale(${scale})` }}>
          <MessageItemTitle>{username}</MessageItemTitle>
          <MessageItemContent>{content.substring(0, 50)}</MessageItemContent>
        </MessageItemContainer>

        {message.role === 'assistant' ? (
          <MessageItemAvatar
            src={avatarSource}
            size={size}
            style={{
              border: isLocalAi ? '1px solid var(--color-border-soft)' : 'none',
              filter: theme === 'dark' ? 'invert(0.05)' : undefined
            }}
          />
        ) : (
          <>
            {isEmoji(avatar) ? (
              <EmojiAvatar
                size={size}
                fontSize={size * 0.6}
                style={{
                  cursor: 'default',
                  pointerEvents: 'none'
                }}>
                {avatar}
              </EmojiAvatar>
            ) : (
              <MessageItemAvatar src={avatar} size={size} />
            )}
          </>
        )}
      </MessageItem>
    )
  }
)

const MessageItemContainer = styled.div`
  line-height: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  text-align: right;
  gap: 3px;
  opacity: 0;
  transform-origin: right center;
  transition: transform cubic-bezier(0.25, 1, 0.5, 1) 150ms;
  will-change: transform;
`

const MessageItemAvatar = styled(Avatar)`
  transition:
    width,
    height,
    cubic-bezier(0.25, 1, 0.5, 1) 150ms;
  will-change: width, height;
`

const MessageLineContainer = styled.div<{ $height: number | null }>`
  width: 14px;
  position: fixed;
  top: calc(50% - var(--status-bar-height) - 10px);
  right: 13px;
  max-height: ${(props) =>
    props.$height ? `${props.$height - 20}px` : 'calc(100% - var(--status-bar-height) * 2 - 20px)'};
  transform: translateY(-50%);
  z-index: 0;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  font-size: 5px;
  overflow: hidden;
  &:hover {
    width: 500px;
    overflow-x: visible;
    overflow-y: hidden;
    ${MessageItemContainer} {
      opacity: 1;
    }
  }
`

const MessagesList = styled.div`
  display: flex;
  flex-direction: column-reverse;
  will-change: transform;
`

const MessageItem = styled.div`
  display: flex;
  position: relative;
  cursor: pointer;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  transform-origin: right center;
  padding: 2px 0;
  will-change: opacity;
  opacity: 0.4;
  transition: opacity 0.1s linear;
`

const MessageItemTitle = styled.div`
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
`
const MessageItemContent = styled.div`
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
`

export default memo(MessageAnchorLine)
