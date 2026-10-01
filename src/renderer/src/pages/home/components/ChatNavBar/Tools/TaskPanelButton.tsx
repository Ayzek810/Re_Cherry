import {
  ensureTopicTasks,
  getTopicTaskSnapshot,
  type GoalPhase,
  subscribeTopicTasks,
  type TopicTaskSnapshot
} from '@renderer/services/sessionTaskState'
import type { Topic } from '@renderer/types'
import { Badge, Drawer, Tag, Tooltip } from 'antd'
import { CheckCircle2, CircleDashed, ListTodo, LoaderCircle, Target } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  topic?: Topic
}

/**
 * 任务面板按钮：工作模式开启的话题在导航工具行显示入口（用户裁决：
 * todo/goal 归工作模式作用域，面板随之）。数据 = 内核会话日志折叠
 * （services/sessionTaskState，todo/write + goal/change last-wins），重放 + 直播双通道。
 */
const TaskPanelButton: FC<Props> = ({ topic }) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const topicId = topic?.id
  const workMode = topic?.workMode === true

  useEffect(() => {
    if (topicId !== undefined) {
      ensureTopicTasks(topicId)
    }
  }, [topicId])

  const subscribe = useCallback(
    (onChange: () => void) => (topicId === undefined ? () => undefined : subscribeTopicTasks(topicId, onChange)),
    [topicId]
  )
  const getSnapshot = useCallback(
    () => (topicId === undefined ? EMPTY_SNAPSHOT : getTopicTaskSnapshot(topicId)),
    [topicId]
  )
  const snapshot: TopicTaskSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (!workMode || topicId === undefined) {
    return null
  }

  const inProgressCount = (snapshot.todos ?? []).filter((todo) => todo.status === 'in_progress').length
  const goalPhase = snapshot.goal?.phase

  return (
    <>
      <Tooltip title={t('tasks.title')} mouseEnterDelay={0.8}>
        <NavbarIconWrap onClick={() => setOpen(true)}>
          <ListTodo size={18} />
          {inProgressCount > 0 && <Badge count={inProgressCount} size="small" style={badgeStyle} />}
        </NavbarIconWrap>
      </Tooltip>
      <Drawer
        placement="right"
        open={open}
        onClose={() => setOpen(false)}
        width="var(--assistants-width)"
        closable={false}
        styles={{ body: { padding: 16, paddingTop: 'calc(var(--navbar-height) + 16px)', overflowY: 'auto' } }}>
        <PanelTitle>
          <ListTodo size={16} />
          <span>{t('tasks.title')}</span>
        </PanelTitle>

        <SectionTitle>
          <Target size={14} />
          <span>{t('tasks.goal.title')}</span>
        </SectionTitle>
        {snapshot.goal === null ? (
          <EmptyHint>{t('tasks.goal.empty')}</EmptyHint>
        ) : (
          <GoalCard>
            <GoalObjective>{snapshot.goal.objective}</GoalObjective>
            <GoalMeta>
              {goalPhase !== undefined && <Tag color={phaseColor[goalPhase]}>{t(PHASE_KEY[goalPhase])}</Tag>}
              <span className="rounds">
                {t('tasks.goal.rounds', {
                  rounds: snapshot.goalRounds,
                  max: snapshot.goal.maxGoalRounds
                })}
              </span>
            </GoalMeta>
            {snapshot.goal.blockedReason !== undefined && (
              <BlockedReason>
                {t('tasks.goal.blockedReason')}：{snapshot.goal.blockedReason.message}
              </BlockedReason>
            )}
          </GoalCard>
        )}

        <SectionTitle>
          <ListTodo size={14} />
          <span>{t('tasks.todos.title')}</span>
        </SectionTitle>
        {(snapshot.todos ?? []).length === 0 ? (
          <EmptyHint>{t('tasks.todos.empty')}</EmptyHint>
        ) : (
          <TodoList>
            {(snapshot.todos ?? []).map((todo, index) => (
              <TodoItem key={index} $status={todo.status}>
                <StatusIcon status={todo.status} />
                <span className="content">{todo.content}</span>
              </TodoItem>
            ))}
          </TodoList>
        )}

        <SourceNote>{t('tasks.source')}</SourceNote>
      </Drawer>
    </>
  )
}

const EMPTY_SNAPSHOT: TopicTaskSnapshot = { todos: null, goal: null, goalRounds: 0 }

const phaseColor: Record<string, string> = {
  active: 'processing',
  paused: 'default',
  blocked: 'error',
  complete: 'success'
}

/** 静态 i18n 键映射（phase 枚举 → 词条键；显式写出以通过 i18n 动态键检查）。 */
const PHASE_KEY: Record<GoalPhase, string> = {
  active: 'tasks.goal.phase.active',
  paused: 'tasks.goal.phase.paused',
  blocked: 'tasks.goal.phase.blocked',
  complete: 'tasks.goal.phase.complete'
}

function StatusIcon({ status }: { status: 'pending' | 'in_progress' | 'completed' }) {
  if (status === 'completed') {
    return <CheckCircle2 size={15} style={statusIconStyle.completed} />
  }
  if (status === 'in_progress') {
    return <LoaderCircle size={15} className="animate-spin" style={statusIconStyle.in_progress} />
  }
  return <CircleDashed size={15} style={statusIconStyle.pending} />
}

const statusIconStyle = {
  pending: { color: 'var(--color-text-3)', flexShrink: 0 },
  in_progress: { color: 'var(--color-primary)', flexShrink: 0 },
  completed: { color: 'var(--color-success, #52c41a)', flexShrink: 0 }
} as const

const badgeStyle = { position: 'absolute', top: 2, right: 2, transform: 'translate(50%,-50%)' } as const

const NavbarIconWrap = styled.div`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.2s;
  color: var(--color-text-1);

  &:hover {
    background-color: var(--color-background-soft, var(--color-background-2));
  }
`

const PanelTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
`

const SectionTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-2);
  margin: 12px 0 8px;
`

const EmptyHint = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  padding: 8px 10px;
  border: 0.5px dashed var(--color-border);
  border-radius: 8px;
`

const GoalCard = styled.div`
  padding: 10px 12px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
`

const GoalObjective = styled.div`
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
`

const GoalMeta = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;

  .rounds {
    font-size: 12px;
    color: var(--color-text-3);
  }
`

const BlockedReason = styled.div`
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-error, #cf1322);
`

const TodoList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const TodoItem = styled.div<{ $status: 'pending' | 'in_progress' | 'completed' }>`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;

  .content {
    word-break: break-word;
    ${(props) =>
      props.$status === 'completed'
        ? 'color: var(--color-text-3); text-decoration: line-through;'
        : props.$status === 'in_progress'
          ? 'font-weight: 500;'
          : ''}
  }
`

const SourceNote = styled.div`
  margin-top: 16px;
  font-size: 11px;
  color: var(--color-text-3);
`

export default TaskPanelButton
