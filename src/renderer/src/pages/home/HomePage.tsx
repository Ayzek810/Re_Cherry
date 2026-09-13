import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import NavigationService from '@renderer/services/NavigationService'
import { updateTopic as updateTopicAction } from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import { listRootTopics, recallLastViewedBranch, rootTopicOf, TOPIC_SWITCH_REQUEST } from '@renderer/utils/topicBranch'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant

const HomePage: FC = () => {
  const { assistants } = useAssistants()
  const navigate = useNavigate()
  const { isLeftNavbar } = useNavbarPosition()

  const location = useLocation()
  const state = location.state

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || assistants[0]
  )
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)
  const { showAssistants, showTopics, topicPosition } = useSettings()
  const { setShowAssistants, toggleShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()
  const dispatch = useDispatch()

  _activeAssistant = activeAssistant

  useShortcut('toggle_show_assistants', () => {
    if (topicPosition === 'right') {
      toggleShowAssistants()
      return
    }

    if (!showAssistants) {
      setShowAssistants(true)
      requestAnimationFrame(() => {
        void EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS)
      })
      return
    }

    void EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS)
  })

  useShortcut('toggle_show_topics', () => {
    if (topicPosition === 'right') {
      toggleShowTopics()
      return
    }

    if (!showAssistants) {
      setShowAssistants(true)
      requestAnimationFrame(() => {
        void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      })
      return
    }

    void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
  })

  // 家族浏览记忆：把"正在看哪个分支"记到根话题行上（进分支记分支 id，回主分支清掉，
  // 同值跳过）。恢复点：侧栏点击 / 切助手 / useTopic 兜底（recallLastViewedBranch）。
  // allTopics 由调用方显式传入——切助手场景闭包里的 activeAssistant 还是旧助手。
  const recordTopicView = useCallback(
    (viewed: Topic, allTopics: Topic[] = activeAssistant?.topics ?? []) => {
      const root = rootTopicOf(viewed, allTopics)
      const next = root.id === viewed.id ? undefined : viewed.id
      if (root.lastViewedBranchId !== next) {
        dispatch(updateTopicAction({ assistantId: root.assistantId, topic: { ...root, lastViewedBranchId: next } }))
      }
    },
    [dispatch, activeAssistant]
  )

  const setActiveAssistant = useCallback(
    (newAssistant: Assistant) => {
      if (newAssistant.id === activeAssistant?.id) return
      startTransition(() => {
        _setActiveAssistant(newAssistant)
        // 同步更新 active topic，避免不必要的重新渲染；进话题恢复上次浏览的分支
        const rootTopics = listRootTopics(newAssistant.topics ?? [])
        const fallbackRoot = rootTopics[0] ?? newAssistant.topics?.[0]
        const newTopic =
          fallbackRoot !== undefined ? recallLastViewedBranch(fallbackRoot, newAssistant.topics ?? []) : undefined
        // newTopic 为 undefined（新助手暂无话题）时保留旧值，useTopic 的 fallback effect 会
        // 检测 activeTopic 不在新助手并回落到其首个根话题（家族记忆恢复）
        _setActiveTopic((prev) => (newTopic !== undefined && newTopic.id !== prev.id ? newTopic : prev))
        if (newTopic !== undefined) recordTopicView(newTopic, newAssistant.topics ?? [])
      })
    },
    [_setActiveTopic, activeAssistant?.id, recordTopicView]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      startTransition(() => {
        _setActiveTopic((prev) => (newTopic.id === prev.id ? prev : newTopic))
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
        recordTopicView(newTopic)
      })
    },
    [_setActiveTopic, dispatch, recordTopicView]
  )

  useEffect(() => {
    NavigationService.setNavigate(navigate)
  }, [navigate])

  // 分支图/分支创建请求切话题：任何组件（含消息菜单深层）都能触发
  useEffect(() => {
    const onTopicSwitchRequest = (event: Event) => {
      const topic = (event as CustomEvent).detail as Topic | undefined
      if (topic && topic.id && topic.id !== activeTopic?.id) {
        setActiveTopic(topic)
      }
    }
    window.addEventListener(TOPIC_SWITCH_REQUEST, onTopicSwitchRequest)
    return () => window.removeEventListener(TOPIC_SWITCH_REQUEST, onTopicSwitchRequest)
  }, [activeTopic?.id, setActiveTopic])

  useEffect(() => {
    state?.assistant && setActiveAssistant(state?.assistant)
    state?.topic && setActiveTopic(state?.topic)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    const canMinimize = topicPosition == 'left' ? !showAssistants : !showAssistants && !showTopics
    void window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [showAssistants, showTopics, topicPosition])

  return (
    <Container id="home-page">
      {isLeftNavbar && (
        <Navbar
          activeAssistant={activeAssistant}
          activeTopic={activeTopic}
          setActiveTopic={setActiveTopic}
          setActiveAssistant={setActiveAssistant}
          position="left"
        />
      )}
      <ContentContainer id={isLeftNavbar ? 'content-container' : undefined}>
        <AnimatePresence initial={false}>
          {showAssistants && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'var(--assistants-width)', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <HomeTabs
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveAssistant={setActiveAssistant}
                  setActiveTopic={setActiveTopic}
                  position="left"
                />
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
        <ErrorBoundary>
          <Chat
            assistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveTopic={setActiveTopic}
            setActiveAssistant={setActiveAssistant}
          />
        </ErrorBoundary>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  [navbar-position='left'] & {
    max-width: calc(100vw - var(--sidebar-width));
  }
  [navbar-position='top'] & {
    max-width: 100vw;
  }
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  overflow: hidden;

  [navbar-position='top'] & {
    max-width: calc(100vw - 12px);
  }
`

export default HomePage
