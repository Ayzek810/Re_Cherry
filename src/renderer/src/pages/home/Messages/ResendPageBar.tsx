import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { addTopic } from '@renderer/store/assistants'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  buildPageFamily,
  type CMPageFamily,
  type CMPagePosition,
  type CMFamily
} from '@renderer/utils/conversationModel'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'
import { kernelRootTopicId, materializeKernelTopicRow, requestTopicSwitch } from '@renderer/utils/topicBranch'
import { useEffect, useState } from 'react'
import styled from 'styled-components'

/**
 * 页码指示器（分叉图合并树的结构投影，用于切换）：
 * 复用 BranchGraph 的成组规则（buildPageFamily）算出"同一父节点下的兄弟组"：
 *   - 答案页：同一提问节点下的全部回复（regenerate 的回复并到祖先提问下，原答亦在内）；
 *   - 提问页：紧随同一回复节点的多个提问（重发/新开问的走向）。
 * 只在当前会话"自有区"里恰好是组成员的卡片下标 <k/n>；父卡、祖先共享区、
 * regenerate 合并掉的提问副本卡一律不标。点箭头 = 把当前会话切到相邻组员所在分支。
 */
const ResendPageBar: React.FC<{ topic: Topic; scopeMessage: Message }> = ({ topic, scopeMessage }) => {
  const dispatch = useAppDispatch()
  const signature = useAppSelector((state) =>
    (state.assistants.assistants.find((a) => a.id === topic.assistantId)?.topics ?? [])
      .map((row) => row.id + ':' + row.updatedAt)
      .join('|')
  )
  const [projection, setProjection] = useState<{ family: CMFamily; page: CMPageFamily } | null>(null)

  useEffect(() => {
    let active = true
    setProjection(null)
    void (async () => {
      const rootId = await kernelRootTopicId(topic.id)
      if (!rootId) return
      const family = await loadConversationTree(rootId, signature)
      const rows = store.getState().assistants.assistants.find((a) => a.id === topic.assistantId)?.topics ?? []
      const kinds: Record<string, string | undefined> = {}
      for (const row of rows) kinds[row.id] = row.branchKind
      if (!active) return
      setProjection({ family, page: buildPageFamily(family, kinds) })
    })()
    return () => {
      active = false
    }
  }, [topic.id, topic.assistantId, signature])

  // 卡片 → (该会话内的轮 / 回复下标)。id 形如 kernel-<topic>-<seq>，取最后一段 seq。
  const seqOf = (id: string | undefined): number | undefined => {
    if (!id) return undefined
    const dash = id.lastIndexOf('-')
    const value = Number(id.slice(dash + 1))
    return Number.isFinite(value) ? value : undefined
  }

  let position: CMPagePosition | null = null
  if (projection) {
    const { family, page } = projection
    const session = family.byId.get(topic.id)
    const userSeqs = session?.userSeqs ?? []
    const replySeqs = session?.replySeqs ?? []
    const kindsOfTopic = store.getState().assistants.assistants
      .find((a) => a.id === topic.assistantId)
      ?.topics.find((row) => row.id === topic.id)?.branchKind

    if (scopeMessage.role === 'assistant') {
      // 回复卡：锚点提问必须在本会话自有区（共享前缀卡不标）
      const ask = scopeMessage.askId ? store.getState().messages.entities[scopeMessage.askId] : undefined
      const askSeq = seqOf(ask?.id)
      const turnIndex = askSeq === undefined ? -1 : userSeqs.indexOf(askSeq)
      if (turnIndex >= (session?.shared ?? 0) && ask?.topicId === topic.id) {
        const seqA = seqOf(scopeMessage.id)
        const replyIndex = seqA === undefined ? -1 : (replySeqs[turnIndex] ?? []).indexOf(seqA)
        if (replyIndex >= 0) {
          const replyNode = topic.id + ':a:' + turnIndex + ':' + replyIndex
          // 该轮提问的规范节点（regenerate 首轮 = 祖先提问）
          const chainUnit = page.chains.get(topic.id)?.[turnIndex]
          const members = chainUnit ? (page.answersOf.get(chainUnit.userId) ?? []) : []
          const currentIndex = members.indexOf(replyNode)
          if (members.length > 1 && currentIndex >= 0) position = { kind: 'reply', members, currentIndex }
        }
      }
    } else {
      // 提问卡：只标"本会话新开出的提问"（重发/新问）；regenerate 合并的提问副本与共享区不标
      const seqU = seqOf(scopeMessage.id)
      const turnIndex = seqU === undefined ? -1 : userSeqs.indexOf(seqU)
      const isMergedCopy = kindsOfTopic === 'regenerate' && turnIndex === session?.shared
      if (turnIndex >= (session?.shared ?? 0) && !isMergedCopy) {
        const userNode = topic.id + ':u:' + turnIndex
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
    const allTopics = state.assistants.assistants.find((a) => a.id === topic.assistantId)?.topics ?? []
    const materialized = await materializeKernelTopicRow({
      sessionId: targetSessionId,
      assistantId: topic.assistantId,
      allTopics,
      fallbackParentId: topic.parentTopicId,
      fallbackName: topic.name
    })
    if (!materialized) return
    if (materialized.created) dispatch(addTopic({ assistantId: topic.assistantId, topic: materialized.row }))
    requestTopicSwitch(materialized.row)
  }

  const prevNode = currentIndex > 0 ? (members[currentIndex - 1] as string) : undefined
  const nextNode = currentIndex < count - 1 ? (members[currentIndex + 1] as string) : undefined

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
