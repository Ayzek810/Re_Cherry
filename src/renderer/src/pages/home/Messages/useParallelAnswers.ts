import { loggerService } from '@logger'
import { loadKernelTopicMessages } from '@renderer/services/kernelChat'
import store, { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import { selectAllTopics } from '@renderer/store/assistants'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'
import { branchKindsOf, familyRowSignature, kernelRootTopicId } from '@renderer/utils/topicBranch'
import { useEffect, useState } from 'react'

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

/** children 列表内容等价（逐字段比较；顺序有意义——它就是展示序）。 */
function parallelChildrenHaveSameItems(a: ParallelChildInfo[], b: ParallelChildInfo[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].anchorQuestionId !== b[i].anchorQuestionId ||
      a[i].copyQuestionId !== b[i].copyQuestionId
    ) {
      return false
    }
  }
  return true
}

/** 装载去重（家族签名不随子会话消息入 store 变化，需防止重复投影）。 */
const loadingTopics = new Set<string>()

/** 无旁答时的共享空 Map：引用恒定，`Messages.tsx` 的 `groupedMessages` 依赖不会因此变化。 */
const EMPTY_PARALLEL_ANSWER_MAP: Map<string, Message[]> = new Map()

/** children 为空（本机没有 parallel 子会话）时短路：不读 store，也不重建 Map。 */
const EMPTY_CHILDREN: ParallelChildInfo[] = []

/** Map 内容等价（key 序 + value 数组逐元素同一引用）。 */
function parallelAnswerMapsHaveSameItems(a: Map<string, Message[]>, b: Map<string, Message[]>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    const other = b.get(key)
    if (other === undefined || other.length !== value.length) return false
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] !== other[i]) return false
    }
  }
  return true
}

/**
 * 旁答投影的选择器（细粒度 + 内容稳定）。
 *
 * 为什么不能直接订阅整个 `state.messages` 切片：那是 `createSlice` 的顶层对象，**任何** messages
 * reducer（含每个流式 tick 的 `updateMessage`/`upsertBlockReference`/`replaceMessageId`）都会换掉它的
 * 引用。而返回值是 `Messages.tsx` 的 `groupedMessages` 的 useMemo 依赖之一，于是一个 token 到达就让
 * 消息区整棵重渲。本 hook 的真实输入只有两个：`entities` 与 `messageIdsByTopic`。
 *
 * 第二层保险：流式期间 `entities` 每 rAF 都换引用，重算无法避免；但旁答集合只在子会话消息真正变化时
 * 才变。内容不变时返回上一次的 Map 引用（与 `store/newMessage.ts` 的 `selectGeneratingTopicIds`
 * 同法），订阅者才不会逐 token 重渲染。
 *
 * 缓存以 `entities` / `messageIdsByTopic` 两个**引用**为键：流式期间它们每帧都变，所以这里是真重算；
 * 内容等价时返回旧 Map。**不用 `createSelector(state, children)` 的二元形态**——reselect 的槽位缓存以
 * 首参（state）为键，state 未变而 children 变时会错误复用上一次结果。
 *
 * 导出供单测（与 `buildParallelAnswerMap` 同为纯函数面）。
 */
let parallelAnswerCacheKey: { entities: Record<string, Message | undefined>; idsByTopic: Record<string, string[]> } = {
  entities: {},
  idsByTopic: {}
}
let parallelAnswerCacheChildren: ParallelChildInfo[] | undefined
let cachedParallelAnswerMap: Map<string, Message[]> | undefined

export function selectParallelAnswerMap(state: RootState, children: ParallelChildInfo[]): Map<string, Message[]> {
  if (children.length === 0) return EMPTY_PARALLEL_ANSWER_MAP
  const entities = state.messages.entities as Record<string, Message | undefined>
  const messageIdsByTopic = state.messages.messageIdsByTopic
  const sameInputs =
    children === parallelAnswerCacheChildren &&
    entities === parallelAnswerCacheKey.entities &&
    messageIdsByTopic === parallelAnswerCacheKey.idsByTopic
  if (sameInputs && cachedParallelAnswerMap !== undefined) return cachedParallelAnswerMap

  parallelAnswerCacheKey = { entities, idsByTopic: messageIdsByTopic }
  parallelAnswerCacheChildren = children
  const next = buildParallelAnswerMap({ messages: { entities, messageIdsByTopic } }, children)
  if (cachedParallelAnswerMap !== undefined && parallelAnswerMapsHaveSameItems(cachedParallelAnswerMap, next)) {
    return cachedParallelAnswerMap
  }
  cachedParallelAnswerMap = next
  return next
}

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
  const [children, setChildren] = useState<ParallelChildInfo[]>(EMPTY_CHILDREN)
  // 细粒度选择器（见 selectParallelAnswerMap）：不再订阅 state.messages 切片根。
  const parallelAnswers = useAppSelector((state) => selectParallelAnswerMap(state, children))
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
        // 内容不变则保持旧数组引用：选择器的第三个输入是 children 本身，
        // 换引用会让「内容稳定的 Map 引用」这层保险白做（并让 effect 依赖的 setChildren 触发无谓重渲）。
        setChildren((prev) => (parallelChildrenHaveSameItems(prev, next) ? prev : next))

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

  return parallelAnswers
}

export default useParallelAnswers
