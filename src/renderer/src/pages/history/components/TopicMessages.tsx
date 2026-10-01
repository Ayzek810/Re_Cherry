import { MessageOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import { getTopicById } from '@renderer/hooks/useTopic'
import { getAssistantById } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { isGenerating, locateToMessage } from '@renderer/services/MessagesService'
import NavigationService from '@renderer/services/NavigationService'
import type { Topic } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { Button, Divider, Empty, Skeleton } from 'antd'
import { t } from 'i18next'
import { Forward } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import { default as MessageItem } from '../../home/Messages/Message'

const logger = loggerService.withContext('TopicMessages')

interface Props extends React.HTMLAttributes<HTMLDivElement> {
  topic?: Topic
}

/**
 * 已取到的话题内容，连同它属于哪个话题 id（f2-53）。
 *
 * 话题行本身**不含 messages**（`store/assistants.ts` 把列表行的 messages 清空），消息要经
 * `loadTopicMessagesThunk` 从内核会话日志投影进 `messageIdsByTopic`。带 id 存值是为了在**渲染期**
 * 就识别出"手上的内容属于上一条话题"：只靠 `useEffect` 清 state 会先渲染一帧旧话题的消息
 * （effect 在渲染之后才跑）。
 */
type LoadedTopic = { id: string; topic: Topic }

const TopicMessages: FC<Props> = ({ topic: _topic, ...props }) => {
  const navigate = NavigationService.navigate!
  const { handleScroll, containerRef } = useScrollPosition('TopicMessages')
  const { messageStyle } = useSettings()
  const { setTimeoutTimer } = useTimer()

  const topicId = _topic?.id
  const [loaded, setLoaded] = useState<LoadedTopic | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    // StrictMode 下 effect 会跑两次（cleanup 也跑）：每次挂载都把标志位复位。
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadTopic = useCallback(async () => {
    if (!topicId) return
    // 先清掉上一条话题的内容：否则取数完成前渲染的是旧话题的消息（f2-53）。
    setLoaded(null)
    setLoadFailed(false)
    setInFlight(true)
    try {
      const topic = await getTopicById(topicId)
      if (!aliveRef.current) return
      // `getTopicById` 用 spread 组装话题：store 里查不到这一行时它返回的是一个 `id` 为
      // undefined 的空壳。那同样是"来源没到手"，不能落到空历史（f2-53）。
      setLoaded(topic?.id ? { id: topicId, topic } : null)
      setLoadFailed(!topic?.id)
    } catch (error) {
      if (!aliveRef.current) return
      logger.error(`Failed to load topic "${topicId}"`, error as Error)
      setLoaded(null)
      setLoadFailed(true)
      window.toast.error(t('history.load_failed'))
    } finally {
      if (aliveRef.current) setInFlight(false)
    }
  }, [topicId])

  useEffect(() => {
    void loadTopic()
  }, [loadTopic])

  if (!_topic) {
    return null
  }

  const onContinueChat = async (topic: Topic) => {
    // r2-62：`isGenerating()` 改返回 `Promise<boolean>`，不再 reject——`true` = 可以继续，
    // `false` = 正在生成（已弹提示）。旧写法只 `await` 不读结果，闸门形同虚设：生成中点击
    // "继续对话"仍会切页，把正在流式的回答丢在后台。必须读返回值并提前返回。
    if (!(await isGenerating())) return
    SearchPopup.hide()
    const assistant = getAssistantById(topic.assistantId)
    navigate('/', { state: { assistant, topic } })
    setTimeoutTimer('onContinueChat', () => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 100)
  }

  // 三态互斥（f2-53）：加载中（骨架）/ 失败（错误条 + 重试）/ 有答案（空态或消息列表）。
  // 三者绝不同形——"失败"不得读成"这个话题没有消息"，"加载中"不得先闪一次空历史。
  // `loaded.id !== topicId` 即"手上是上一条话题的内容"，渲染期直接算作加载中。
  const loadedTopic = loaded !== null && loaded.id === topicId ? loaded.topic : null
  const isPending = loadedTopic === null && (!loadFailed || inFlight)
  const messages = loadedTopic?.messages ?? []
  const isEmpty = !isPending && !loadFailed && messages.length === 0

  const renderContent = () => {
    if (isPending) {
      return (
        <LoadingState data-testid="history-topic-loading">
          <Skeleton active paragraph={{ rows: 4 }} title={false} />
        </LoadingState>
      )
    }

    if (loadFailed) {
      return (
        <ErrorState data-testid="history-topic-error">
          <span>{t('history.load_failed')}</span>
          <Button size="small" onClick={() => void loadTopic()}>
            {t('common.retry')}
          </Button>
        </ErrorState>
      )
    }

    return (
      <>
        {messages.map((message) => (
          <MessageWrapper key={message.id} className={classNames([messageStyle, message.role])}>
            <MessageItem message={message} topic={loadedTopic!} hideMenuBar={true} />
            <Button
              type="text"
              size="middle"
              style={{ color: 'var(--color-text-3)', position: 'absolute', right: 0, top: 5 }}
              onClick={() => locateToMessage(navigate, message)}
              icon={<Forward size={16} />}
            />
            <Divider style={{ margin: '8px auto 15px' }} variant="dashed" />
          </MessageWrapper>
        ))}
        {isEmpty && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        {!isEmpty && loadedTopic && (
          <HStack justifyContent="center">
            <Button onClick={() => onContinueChat(loadedTopic)} icon={<MessageOutlined />}>
              {t('history.continue_chat')}
            </Button>
          </HStack>
        )}
      </>
    )
  }

  return (
    <MessageEditingProvider>
      <MessagesContainer {...props} ref={containerRef} onScroll={handleScroll}>
        <ContainerWrapper className={messageStyle}>{renderContent()}</ContainerWrapper>
      </MessagesContainer>
    </MessageEditingProvider>
  )
}

const MessagesContainer = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-y: scroll;
`

const ContainerWrapper = styled.div`
  width: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
`

/** 加载态占位：静默留白是最差失败形态（CLAUDE.md §9 rendering）。 */
const LoadingState = styled.div`
  width: 100%;
  padding: 8px 0;
`

/** 取数失败态：与"这个话题没有消息"显式分离，并给出重试入口（f2-53）。 */
const ErrorState = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  font-size: 13px;
  color: var(--color-error);
`

const MessageWrapper = styled.div`
  position: relative;
  &.bubble.user {
    padding-top: 26px;
  }
`

export default TopicMessages
