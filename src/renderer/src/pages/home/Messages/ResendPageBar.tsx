import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { addTopic, owningAssistantOfTopic, selectAllTopics } from '@renderer/store/assistants'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  buildPageFamily,
  type CMFamily,
  type CMPageFamily,
  type CMPagePosition
} from '@renderer/utils/conversationModel'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'
import {
  branchKindsOf,
  familyRowSignature,
  kernelRootTopicId,
  materializeKernelTopicRow,
  requestTopicSwitch
} from '@renderer/utils/topicBranch'
import { useEffect, useState } from 'react'
import styled from 'styled-components'

const logger = loggerService.withContext('ResendPageBar')

/**
 * 页码指示器（分叉图合并树的结构投影，用于切换）：
 * 复用 BranchGraph 的成组规则（buildPageFamily）算出"同一父节点下的兄弟组"：
 *   - 答案页：同一提问节点下的全部回复（regenerate 的回复并到祖先提问下，原答亦在内）；
 *   - 提问页：紧随同一回复节点的多个提问（重发/新开问的走向）。
 * 每张卡按**内容出身**（chains 的规范节点）归组：共享前缀卡映射回祖先会话的组员，
 * 分支删掉的 regenerate 提问副本在祖先组只有自己时仍不标。真机实证的反例是旧版
 * 门控"只标本会话自有区"（turnIndex >= sharedBoundary + 自拼 topic.id 节点）：
 * 共享区卡片既被门控排除、拼出的节点 id 又不在 origin 组里——一旦下一级有分支、
 * 视图沉到深层，**上一级所有分叉点的页码整体消失**（深层视图只剩本会话边界那一条）。
 * 本组件的口径就是"当前视图路径上每一辈的分叉都可见、可翻页"。点箭头 = 把当前
 * 会话切到相邻组员所在分支。parallel 旁答子会话不在页码体系内（顶部短路）。
 */
const ResendPageBar: React.FC<{ topic: Topic; scopeMessage: Message }> = ({ topic, scopeMessage }) => {
  const dispatch = useAppDispatch()
  // 口径总则（两处权威，缺一不可）：
  // ① branchKind 判定 = **跨助手联合**（selectAllTopics + branchKindsOf 首个有值获胜）——
  //    与分支图完全同一份。此前取"归属助手"单一清单：同一家族的行分属不同助手时，
  //    本侧读到 kind=undefined → regenerate 该合并的不合并，与图的合并结构对不上。
  // ② 切页/签名/物化落点 = **成员归属**（owningAssistantOfTopic，绝不信任行上的
  //    assistantId 字段——历史污染行字段可能是旧归属，按字段找拿到错误清单）。
  const owningAssistantId = useAppSelector(
    (state) => owningAssistantOfTopic(state.assistants.assistants, topic.id)?.id ?? ''
  )
  // 签名域 = 本家族的行（跨助手联合，与图同口径）：投影消费联合 kind 表，
  // 任何一侧持有者改行都必须失效缓存
  const signature = useAppSelector((state) => familyRowSignature(selectAllTopics(state), topic.id))
  const [projection, setProjection] = useState<{ family: CMFamily; page: CMPageFamily } | null>(null)

  useEffect(() => {
    let active = true
    // stale-while-revalidate：签名刷新时**保留上一次投影**直到新家族就绪——绝不先清空。
    // 此前每次签名变动（发送/回合结束都会提升 updatedAt）先 setProjection(null) 再异步
    // 重取，期间全部页码条整体消失再重挂（闪烁/乱跳）；取数若瞬时失败，projection 停在
    // null 直到下次签名变动 = 页码永久缺席、与分支图对不上。宁旧勿假、宁旧勿空。
    void (async () => {
      try {
        const rootId = await kernelRootTopicId(topic.id)
        if (!rootId || !active) return
        const family = await loadConversationTree(rootId, signature)
        const kinds = branchKindsOf(selectAllTopics(store.getState()))
        if (!active) return
        setProjection({ family, page: buildPageFamily(family, kinds) })
      } catch (error) {
        // 家族取数失败（含重试窗口用尽）：保留旧投影继续显示（宁旧勿空）；
        // 缓存层保证失败不会被吞成"少了分支的假树"，这里只兜住 rejection。
        logger.warn('failed to load family of ' + topic.id, error instanceof Error ? error : new Error(String(error)))
      }
    })()
    return () => {
      active = false
    }
  }, [topic.id, signature])

  // 卡片 → (该会话内的轮 / 回复下标)。id 形如 kernel-<topic>-<seq>，取最后一段 seq。
  const seqOf = (id: string | undefined): number | undefined => {
    if (!id) return undefined
    const dash = id.lastIndexOf('-')
    const value = Number(id.slice(dash + 1))
    return Number.isFinite(value) ? value : undefined
  }

  // 并行回答卡（来自隐藏 parallel 子会话的消息）不属于当前会话页码体系：不标 <k/n>
  if (scopeMessage.topicId !== topic.id) {
    return null
  }

  let position: CMPagePosition | null = null
  if (projection) {
    const { family, page } = projection
    const session = family.byId.get(topic.id)
    const userSeqs = session?.userSeqs ?? []
    const replySeqs = session?.replySeqs ?? []
    // 自有区边界不再参与门控：共享/自有全按内容出身归组（chains 由 buildPageFamily
    // 建链：共享轮直接引用祖先 unit，其节点的钳制语义见 conversationModel）。

    if (scopeMessage.role === 'assistant') {
      // 回复卡：锚点提问定位到本会话轮（共享前缀轮同样定位——那正是祖先分叉点的卡）
      const ask = scopeMessage.askId ? store.getState().messages.entities[scopeMessage.askId] : undefined
      const askSeq = seqOf(ask?.id)
      const turnIndex = askSeq === undefined ? -1 : userSeqs.indexOf(askSeq)
      if (turnIndex >= 0 && ask?.topicId === topic.id) {
        const seqA = seqOf(scopeMessage.id)
        const replyIndex = seqA === undefined ? -1 : (replySeqs[turnIndex] ?? []).indexOf(seqA)
        if (replyIndex >= 0) {
          // 该轮的规范 unit（regenerate 首轮 = 祖先提问的 unit；共享轮 = 祖先 unit 整体）
          const chainUnit = page.chains.get(topic.id)?.[turnIndex]
          // 组员 id 跟随内容出身：自有轮 = 本会话节点，共享/合并轮 = 祖先会话节点。
          // 自拼 topic.id + ':a:' + … 在共享区拼不出组里的 id（组员是 origin 的），
          // 旧版因此永远差一格——这是"祖先级页码消失"的第二半病因。
          const replyNode = chainUnit?.replyIds[replyIndex] ?? topic.id + ':a:' + turnIndex + ':' + replyIndex
          const members = chainUnit ? (page.answersOf.get(chainUnit.userId) ?? []) : []
          const currentIndex = members.indexOf(replyNode)
          if (members.length > 1 && currentIndex >= 0) position = { kind: 'reply', members, currentIndex }
        }
      }
    } else {
      // 提问卡：只标"成组的提问"（同一回复后的多个提问 = 分叉走向）。节点同样按内容
      // 出身取规范 id：共享轮与 regenerate 合并副本都映射到祖先提问节点——祖先提问
      // 自身有分叉组时，深层视图里同样能看到那一辈的分叉页码；组里只有自己则不标
      //（合并副本在祖先组单员时天然无条，与旧行为一致）。
      const seqU = seqOf(scopeMessage.id)
      const turnIndex = seqU === undefined ? -1 : userSeqs.indexOf(seqU)
      if (turnIndex >= 0) {
        const chainUnit = page.chains.get(topic.id)?.[turnIndex]
        const userNode = chainUnit?.userId ?? topic.id + ':u:' + turnIndex
        const parentReply = page.userPageParentOf.get(userNode)
        const members = parentReply === undefined ? [] : (page.questionsOf.get(parentReply) ?? [])
        const currentIndex = members.indexOf(userNode)
        if (members.length > 1 && currentIndex >= 0) position = { kind: 'question', members, currentIndex }
      }
    }
  }

  if (!position) return null
  const { members, currentIndex } = position
  const count = members.length

  // 成员节点 → 所在会话（切换目标）：回复节点直接查归属；提问节点查 owner。
  const sessionOfNode = (nodeId: string): string | null => {
    const owner = projection?.page.replyOwnerOf.get(nodeId)
    if (owner) return owner.sessionId
    return projection?.page.userOwnerOf.get(nodeId) ?? null
  }

  const switchTo = async (nodeId: string): Promise<void> => {
    const targetSessionId = sessionOfNode(nodeId)
    if (!targetSessionId) return
    const state = store.getState()
    // 目标助手 = 本话题行的实际持有者（成员归属权威；行字段可陈旧——见组件头注释）。
    // 查找域 = 跨助手联合（allRows）：目标会话的行若在其他助手名下，命中已有行即可，
    // 绝不往归属助手里造 kindless 重复行（跨助手切页的旧病根）
    const owner = owningAssistantOfTopic(state.assistants.assistants, topic.id)
    const ownerId = owner?.id ?? owningAssistantId
    if (ownerId.length === 0) return
    const materialized = await materializeKernelTopicRow({
      sessionId: targetSessionId,
      assistantId: ownerId,
      allTopics: selectAllTopics(state),
      fallbackParentId: topic.parentTopicId,
      fallbackName: topic.name
    })
    if (!materialized) return
    if (materialized.created) dispatch(addTopic({ assistantId: ownerId, topic: materialized.row }))
    requestTopicSwitch(materialized.row)
  }

  const prevNode = currentIndex > 0 ? members[currentIndex - 1] : undefined
  const nextNode = currentIndex < count - 1 ? members[currentIndex + 1] : undefined

  return (
    <Bar>
      <NavButton disabled={prevNode === undefined} onClick={() => prevNode !== undefined && void switchTo(prevNode)}>
        <LeftOutlined />
      </NavButton>
      <PageNum>
        {currentIndex + 1}/{count}
      </PageNum>
      <NavButton disabled={nextNode === undefined} onClick={() => nextNode !== undefined && void switchTo(nextNode)}>
        <RightOutlined />
      </NavButton>
    </Bar>
  )
}

const Bar = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-3);
  margin-top: 2px;
  user-select: none;
`
const NavButton = styled.button`
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  display: inline-flex;
  &:disabled {
    color: var(--color-text-4);
    cursor: default;
  }
`
const PageNum = styled.span`
  font-variant-numeric: tabular-nums;
`

export default ResendPageBar
