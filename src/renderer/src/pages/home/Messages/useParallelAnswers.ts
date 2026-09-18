import { loggerService } from '@logger'
import { loadKernelTopicMessages } from '@renderer/services/kernelChat'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectAllTopics } from '@renderer/store/assistants'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'
import { branchKindsOf, familyRowSignature, kernelRootTopicId } from '@renderer/utils/topicBranch'
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
  // 口径与页码条/分支图统一：branchKind = **跨助手联合**（branchKindsOf，首个有值获胜）；
  // 签名 = 家族行（联合域）familyRowSignature——无关话题的 updatedAt 变动不再推翻旁答投影，
  // 另一侧持有者改行照样刷新。
  const signature = useAppSelector((state) => familyRowSignature(selectAllTopics(state), topic.id))

  useEffect(() => {
    let active = true
    // stale-while-revalidate：签名刷新时保留上一次子会话集直到新的就绪（旁答卡不闪烁）。
    // 旧集的锚点 id 挂着旧话题的消息 id，切题后不会匹配到新题的任何卡片（惰性无害），
    // 下一次成功解析会整体替换。
    void (async () => {
      try {
        const rootId = await kernelRootTopicId(topic.id)
        if (!rootId || !active) return
        const family = await loadConversationTree(rootId, signature)
        if (!active) return
        const kinds = branchKindsOf(selectAllTopics(store.getState()))
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
      } catch (error) {
        // 家族取数失败（含重试窗口用尽）：旁答条这次不渲染即可，绝不把失败当成
        // "没有 parallel 子会话"伪装成功——缓存层同样保证不吞成分支缺失。
        logger.warn('failed to load family of ' + topic.id, error instanceof Error ? error : new Error(String(error)))
      }
    })()
    return () => {
      active = false
    }
  }, [topic.id, signature, dispatch])

  return useMemo(() => buildParallelAnswerMap({ messages: messagesState }, children), [messagesState, children])
}

export default useParallelAnswers
