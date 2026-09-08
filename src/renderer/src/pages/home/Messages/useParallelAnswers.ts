import { loggerService } from '@logger'
import { loadKernelTopicMessages } from '@renderer/services/kernelChat'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'
import { kernelRootTopicId } from '@renderer/utils/topicBranch'
import { useEffect, useMemo, useState } from 'react'

const logger = loggerService.withContext('useParallelAnswers')

export interface ParallelChildInfo {
  /** parallel 子会话 id。 */
  id: string
  /** 锚点问题（当前话题的轮）在当前会话里的 message id。 */
  anchorQuestionId: string
  /** 子会话里问题拷贝的 message id（旁答的 askId 匹配目标）。 */
  copyQuestionId: string
}

/**
 * 把已入 store 的 parallel 子会话消息，按"锚点问题 message id → 旁答列表"归并。
 * 纯函数（可单测）：只消费 messages 状态，children 由 useParallelAnswers 的家族解析产出。
 */
export function buildParallelAnswerMap(
  state: { messages: { entities: Record<string, Message | undefined>; messageIdsByTopic: Record<string, string[]> } },
  children: ParallelChildInfo[]
): Map<string, Message[]> {
  const map = new Map<string, Message[]>()
  for (const child of children) {
    const ids = state.messages.messageIdsByTopic[child.id] ?? []
    const answers: Message[] = []
    for (const id of ids) {
      const entity = state.messages.entities[id]
      if (entity !== undefined && entity.role === 'assistant' && entity.askId === child.copyQuestionId) {
        answers.push(entity)
      }
    }
    if (answers.length === 0) continue
    // family.sessions 为创建序：同锚多模型时按 fork 顺序追加（稳定展示序）
    const existing = map.get(child.anchorQuestionId)
    if (existing !== undefined) existing.push(...answers)
    else map.set(child.anchorQuestionId, answers)
  }
  return map
}

/** 装载去重（家族签名不随子会话消息入 store 变化，需防止重复投影）。 */
const loadingTopics = new Set<string>()

/**
 * 并行回答投影（v1 多模型卡片的数据源）：
 * 以当前话题为视图，解析其家族中 branchKind='parallel' 的直接子会话——
 * fork 时 seed 截至锚点轮之前，故子会话 shared = 锚点轮在当前会话的轮序，
 * 据此把"子会话自有轮的回答"归到当前会话对应问题的答案组。
 * 重启恢复：尚未入 store 的子会话按需从内核日志还原（不走 loadTopicMessagesThunk，
 * 避免 currentTopicId 指到隐藏会话）。
 */
export function useParallelAnswers(topic: Topic): Map<string, Message[]> {
  const dispatch = useAppDispatch()
  const [children, setChildren] = useState<ParallelChildInfo[]>([])
  const messagesState = useAppSelector((state) => state.messages)
  const signature = useAppSelector((state) =>
    (state.assistants.assistants.find((a) => a.id === topic.assistantId)?.topics ?? [])
      .map((row) => row.id + ':' + row.updatedAt)
      .join('|')
  )

  useEffect(() => {
    let active = true
    setChildren([])
    void (async () => {
      const rootId = await kernelRootTopicId(topic.id)
      if (!rootId || !active) return
      const family = await loadConversationTree(rootId, signature)
      if (!active) return
      const rows = store.getState().assistants.assistants.find((a) => a.id === topic.assistantId)?.topics ?? []
      const kinds: Record<string, string | undefined> = {}
      for (const row of rows) kinds[row.id] = row.branchKind
      const current = family.byId.get(topic.id)
      const next: ParallelChildInfo[] = []
      for (const session of family.sessions) {
        if (session.parentTopicId !== topic.id || kinds[session.id] !== 'parallel') continue
        // 子会话 shared = 锚点轮在当前会话的轮序（fork seed 截至锚点轮之前）
        const anchorSeq = current?.userSeqs?.[session.shared]
        const copySeq = session.userSeqs?.[session.shared]
        if (anchorSeq === undefined || copySeq === undefined) continue
        next.push({
          id: session.id,
          anchorQuestionId: 'kernel-' + topic.id + '-' + anchorSeq,
          copyQuestionId: 'kernel-' + session.id + '-' + copySeq
        })
      }
      setChildren(next)

      // 重启恢复：还没进 store 的子会话从内核日志按需还原
      for (const child of next) {
        if (loadingTopics.has(child.id)) continue
        const existingIds = store.getState().messages.messageIdsByTopic[child.id]
        if (existingIds !== undefined && existingIds.length > 0) continue
        loadingTopics.add(child.id)
        void (async () => {
          try {
            const kernelData = await loadKernelTopicMessages(child.id)
            if (!kernelData) return
            if (kernelData.blocks.length > 0) dispatch(upsertManyBlocks(kernelData.blocks))
            const known = new Set(store.getState().messages.messageIdsByTopic[child.id] ?? [])
            for (const message of kernelData.messages) {
              if (!known.has(message.id)) {
                dispatch(newMessagesActions.addMessage({ topicId: child.id, message }))
              }
            }
          } catch (error) {
            logger.warn(
              'useParallelAnswers: failed to restore ' + child.id,
              error instanceof Error ? error : new Error(String(error))
            )
          } finally {
            loadingTopics.delete(child.id)
          }
        })()
      }
    })()
    return () => {
      active = false
    }
  }, [topic.id, topic.assistantId, signature, dispatch])

  return useMemo(() => buildParallelAnswerMap({ messages: messagesState }, children), [messagesState, children])
}

export default useParallelAnswers
