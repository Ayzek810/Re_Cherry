import { loggerService } from '@logger'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import NavigationService from '@renderer/services/NavigationService'
import store from '@renderer/store'
import { owningAssistantOfTopic, updateTopic as updateTopicAction } from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setLastActiveLocation } from '@renderer/store/settings'
import type { Assistant, Topic } from '@renderer/types'
import { listRootTopics, recallLastViewedBranch, rootTopicOf, TOPIC_SWITCH_REQUEST } from '@renderer/utils/topicBranch'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant

const logger = loggerService.withContext('HomePage')

const HomePage: FC = () => {
  const { assistants } = useAssistants()
  const navigate = useNavigate()
  const { isLeftNavbar } = useNavbarPosition()

  const location = useLocation()
  const state = location.state
  const settings = useSettings()

  // 启动落点记忆（v0.3.0-5）：退出时在哪个助手/话题，重启就回到哪里。
  // PersistGate 保证 rehydrate 完成后才挂载本组件——初始化器里读 settings 是安全的。
  // 显式导航（state.assistant/state.topic）优先于记忆。
  const rememberedAssistant =
    state?.assistant ||
    _activeAssistant ||
    assistants.find((candidate) => candidate.id === settings.lastActiveAssistantId) ||
    assistants[0]
  const rememberedTopic = state
    ? state.topic
    : rememberedAssistant && settings.lastActiveTopicId
      ? (rememberedAssistant.topics ?? []).find((candidate) => candidate.id === settings.lastActiveTopicId)
      : undefined

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(rememberedAssistant)
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', rememberedTopic)
  const { showAssistants, showTopics, topicPosition } = useSettings()
  const { setShowAssistants, toggleShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()
  const dispatch = useDispatch()

  _activeAssistant = activeAssistant

  // 退出状态记录：落点一稳定（助手+话题）就写入持久化 settings，供下次启动恢复。
  // 只记 id（行本身随 assistants persist），重放时按 id 现查——行被对账剪除时自然回落。
  useEffect(() => {
    if (activeAssistant?.id && activeTopic?.id) {
      dispatch(setLastActiveLocation({ assistantId: activeAssistant.id, topicId: activeTopic.id }))
    }
  }, [activeAssistant?.id, activeTopic?.id, dispatch])

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
  // allTopics / assistantId 由调用方显式传入——切助手场景闭包里的 activeAssistant 还是旧助手。
  // **助手隔离适配（v0.3.0-5）**：派发目标必须是"实际持有该家族行的助手"，不能信行上的
  // assistantId 字段——隔离对账前的历史行该字段可能是旧归属，派发到错误的助手 = 更新落空 = 记忆丢失。
  // 顺带把行上的 assistantId 字段修正为真实归属。
  const recordTopicView = useCallback(
    (viewed: Topic, assistantId = activeAssistant?.id, allTopics: Topic[] = activeAssistant?.topics ?? []) => {
      if (!assistantId) return
      const root = rootTopicOf(viewed, allTopics)
      const next = root.id === viewed.id ? undefined : viewed.id
      if (root.lastViewedBranchId !== next || root.assistantId !== assistantId) {
        // ③诊断日志（v0.3.1 第三轮"切回落错分支"取证）：记录每次记忆写入的落点，
        // 与 Topics.onSwitchTopic 的召回日志配套对读（真机日志过滤 topicView）。
        logger.info(`[topicView] record: assistant=${assistantId} root=${root.id} branch=${next ?? '(root)'}`)
        dispatch(updateTopicAction({ assistantId, topic: { ...root, assistantId, lastViewedBranchId: next } }))
      }
    },
    [dispatch, activeAssistant]
  )

  const setActiveAssistant = useCallback(
    (newAssistant: Assistant) => {
      if (newAssistant.id === activeAssistant?.id) return
      // 不用 startTransition（与 setActiveTopic 同理：transition 在真机并发更新下可能永不 commit）
      _setActiveAssistant(newAssistant)
      // 同步更新 active topic；进助手恢复上次浏览的分支
      const rootTopics = listRootTopics(newAssistant.topics ?? [])
      const fallbackRoot = rootTopics[0] ?? newAssistant.topics?.[0]
      const newTopic =
        fallbackRoot !== undefined ? recallLastViewedBranch(fallbackRoot, newAssistant.topics ?? []) : undefined
      // newTopic 为 undefined（新助手暂无话题）时保留旧值，useTopic 的 fallback effect 会
      // 检测 activeTopic 不在新助手并回落到其首个根话题（家族记忆恢复）
      _setActiveTopic((prev) => (newTopic !== undefined && newTopic.id !== prev.id ? newTopic : prev))
      if (newTopic !== undefined) recordTopicView(newTopic, newAssistant.id, newAssistant.topics ?? [])
    },
    [_setActiveTopic, activeAssistant?.id, recordTopicView]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      // 话题切换是用户 initiated 的紧急更新：不能用 startTransition 包裹——真机实测（v0.3.0-4 排障）
      // transition 渲染被并发 urgent 更新（redux persist 刷写、行对象更换）饿死后永不 commit，
      // 表现为"点了分支但界面纹丝不动"。此处保持同步 urgent 语义。
      _setActiveTopic((prev) => (newTopic.id === prev.id ? prev : newTopic))
      // v0.3.1 第三轮：fulfilled 清除与写入端同域（**根 id 投影**）——kernelChat.finishTurn
      // 把"完成"记在根行上（侧栏灯的粒度=家族），进话题清的是根投影，否则子分支的未读
      // 在侧栏永远消不掉/提前消掉。rootTopicOf 用行对象上溯：newTopic 尚未入本帧
      // assistant.topics 也能经由 parentTopicId 找到根。
      const rootId = rootTopicOf(newTopic, activeAssistant?.topics ?? []).id
      dispatch(newMessagesActions.setTopicFulfilled({ topicId: rootId, fulfilled: false }))
      recordTopicView(newTopic)
    },
    [_setActiveTopic, dispatch, recordTopicView, activeAssistant]
  )

  useEffect(() => {
    NavigationService.setNavigate(navigate)
  }, [navigate])

  // 分支图/分支创建请求切话题：任何组件（含消息菜单深层）都能触发
  useEffect(() => {
    const onTopicSwitchRequest = (event: Event) => {
      const topic = (event as CustomEvent).detail as Topic | undefined
      if (!topic || !topic.id || topic.id === activeTopic?.id) return
      // 跨助手落点（真机实证的死点击）：目标行的实际持有者若不是当前激活助手，
      // 只切话题会被 useActiveTopic 的兜底 effect 立即弹回（行不在当前助手名下）——
      // 表现为"点了分支图/页码条箭头没反应"。归属权威 = 成员归属（哪份清单持有该行），
      // 需要时连助手一起切过去。
      const owner = owningAssistantOfTopic(store.getState().assistants.assistants, topic.id)
      if (owner && activeAssistant && owner.id !== activeAssistant.id) {
        setActiveAssistant(owner)
      }
      setActiveTopic(topic)
    }
    window.addEventListener(TOPIC_SWITCH_REQUEST, onTopicSwitchRequest)
    return () => window.removeEventListener(TOPIC_SWITCH_REQUEST, onTopicSwitchRequest)
  }, [activeTopic?.id, activeAssistant, setActiveAssistant, setActiveTopic])

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
