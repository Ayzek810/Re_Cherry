/**
 * 追问队列面板（V2 QueuedFollowupsDock 同构裁剪）：工作模式话题在回合
 * 进行中入队的追问列表。条目动作 = 移除 / 编辑（移出队列交还输入框）；队列级动作 =
 * 暂停/恢复自动发送。steer（插入当前轮）需要内核 mid-turn 注入缝，暂缺，不提供。
 */
import { ActionIconButton } from '@renderer/components/Buttons'
import { DeleteIcon } from '@renderer/components/Icons'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { removeFollowup, selectFollowupQueue, setFollowupPaused } from '@renderer/store/followupQueue'
import { CirclePause, CirclePlay, PencilLine } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  topicId: string
  /** 编辑 = 把文本交还输入框（调用方 setText），队列条目移除。 */
  onEdit: (text: string) => void
  /** 编辑后聚焦输入框。 */
  onFocusInput: () => void
}

const FollowupQueueDock: FC<Props> = ({ topicId, onEdit, onFocusInput }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const queue = useAppSelector((state) => selectFollowupQueue(state, topicId))

  if (queue.items.length === 0) return null

  const handleEdit = (text: string, id: string) => {
    dispatch(removeFollowup({ topicId, id }))
    onEdit(text)
    onFocusInput()
  }

  return (
    <DockContainer role="region" aria-label={t('followupQueue.title')}>
      <DockHeader>
        <DockTitle>
          {queue.paused
            ? t('followupQueue.pausedCount', { count: queue.items.length })
            : t('followupQueue.queuedCount', { count: queue.items.length })}
        </DockTitle>
        <ActionIconButton
          onClick={() => dispatch(setFollowupPaused({ topicId, paused: !queue.paused }))}
          aria-label={queue.paused ? t('followupQueue.resume') : t('followupQueue.pause')}
          title={queue.paused ? t('followupQueue.resume') : t('followupQueue.pause')}>
          {queue.paused ? <CirclePlay size={14} /> : <CirclePause size={14} />}
        </ActionIconButton>
      </DockHeader>
      <DockList>
        {queue.items.map((item) => (
          <DockItem key={item.id}>
            <ItemText title={item.text}>{item.text}</ItemText>
            <ItemActions>
              <ActionIconButton
                onClick={() => handleEdit(item.text, item.id)}
                aria-label={t('followupQueue.edit')}
                title={t('followupQueue.edit')}>
                <PencilLine size={13} />
              </ActionIconButton>
              <ActionIconButton
                onClick={() => dispatch(removeFollowup({ topicId, id: item.id }))}
                aria-label={t('followupQueue.remove')}
                title={t('followupQueue.remove')}>
                <DeleteIcon size={13} />
              </ActionIconButton>
            </ItemActions>
          </DockItem>
        ))}
      </DockList>
      <DockHint>{t('followupQueue.hint')}</DockHint>
    </DockContainer>
  )
}

const DockContainer = styled.div`
  width: 100%;
  margin-bottom: 8px;
  padding: 8px 12px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-2);
`

const DockHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const DockTitle = styled.span`
  font-size: 12px;
  color: var(--color-text-2);
`

const DockList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  max-height: 132px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
`

const DockItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--color-background-3);
`

const ItemText = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-1);
`

const ItemActions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
`

const DockHint = styled.div`
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-3);
`

export default FollowupQueueDock
