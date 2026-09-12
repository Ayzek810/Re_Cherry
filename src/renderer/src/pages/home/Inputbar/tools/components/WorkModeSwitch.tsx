import { updateTopic } from '@renderer/store/assistants'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import type { Topic } from '@renderer/types'
import { Switch, Tooltip } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  assistantId: string
  topic: Topic
}

function findLiveTopic(assistantId: string, topicId: string): Topic | undefined {
  return store
    .getState()
    .assistants.assistants.find((assistant) => assistant.id === assistantId)
    ?.topics.find((topicItem) => topicItem.id === topicId)
}

/**
 * 工作模式滑动开关（输入条底栏、发送键左侧）。
 * 与思考档位同构：纯渲染层话题开关（随 redux-persist 持久化），不与内核通信、不解析模型；
 * 发送时作为参数进内核挂/撤工具面并落档位（拨动下一轮才生效，B1）。
 * 话题尚未拨过开关时按助手默认（workMode.defaultEnabled）播种一次。
 */
const WorkModeSwitch: FC<Props> = ({ assistantId, topic: topicProp }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const topicId = topicProp.id

  // 话题开关镜像：undefined = 未拨过（未持久化状态，可按助手默认播种）
  const mirror = useAppSelector((state) =>
    state.assistants.assistants
      .find((assistant) => assistant.id === assistantId)
      ?.topics.find((topicItem) => topicItem.id === topicId)?.workMode
  )
  const defaultEnabled = useAppSelector(
    (state) => state.assistants.assistants.find((assistant) => assistant.id === assistantId)?.workMode?.defaultEnabled
  )
  const enabled = mirror === true

  useEffect(() => {
    if (mirror !== undefined || defaultEnabled !== true) return
    const liveTopic = findLiveTopic(assistantId, topicId)
    if (liveTopic === undefined || liveTopic.workMode !== undefined) return
    dispatch(updateTopic({ assistantId, topic: { ...liveTopic, workMode: true } }))
  }, [assistantId, defaultEnabled, dispatch, mirror, topicId])

  const onToggle = useCallback(() => {
    const liveTopic = findLiveTopic(assistantId, topicId)
    if (liveTopic === undefined) return
    dispatch(updateTopic({ assistantId, topic: { ...liveTopic, workMode: !(liveTopic.workMode === true) } }))
  }, [assistantId, dispatch, topicId])

  return (
    <Tooltip
      placement="top"
      title={enabled ? t('message.workMode.enabled') : t('message.workMode.disabled')}
      mouseLeaveDelay={0}
      arrow>
      <Switch size="small" checked={enabled} onChange={onToggle} aria-label={t('message.workMode.toggle')} />
    </Tooltip>
  )
}

export default WorkModeSwitch
