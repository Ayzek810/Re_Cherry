import '@xyflow/react/dist/style.css'

import { UserOutlined } from '@ant-design/icons'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { useTheme } from '@renderer/context/ThemeProvider'
import type { Model } from '@renderer/types'
import { originOf } from '@renderer/utils/conversationModel'
import { useConversationTree } from '@renderer/hooks/useConversationTree'
import { type Edge, MarkerType, type Node } from '@xyflow/react'
import {
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import { Avatar, Empty, Spin, Tooltip } from 'antd'
import { memo, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface BranchGraphProps {
  rootTopicId: string
  activeTopicId?: string
  branchKinds?: Record<string, string | undefined>
  /** 数据变更签名（话题行增删/更新时变化 → 触发重新拉取）。 */
  refreshKey?: string
  onOpenBranch: (sessionId: string, name?: string) => void
}

type TreeNodeRole = 'user' | 'assistant'

interface TreeNodeData {
  nodeId: string
  sessionId: string
  role: TreeNodeRole
  turnIndex: number
  text: string
  isActive: boolean
  /** 是否位于"起点 → 当前选中位置"的活跃链上（整条链用统一淡蓝填充）。 */
  isOnActivePath: boolean
  modelId?: string
  provider?: string
  modelName?: string
  /** 点击跳转目标会话：本节点沿"左子树（最早路径）"一路到底的那个会话 id；等于自身时省略。 */
  openSessionId?: string
}

const NODE_W = 280
const NODE_H = 96
const RANK_SEP = 120
const SLOT_W = 360

// 活跃链统一强调色（淡蓝）
const PATH_FILL = 'rgba(125, 172, 253, 0.16)'
const ACTIVE_FILL = 'rgba(96, 143, 235, 0.3)'
const PATH_BORDER = 'rgba(125, 172, 253, 0.6)'
const PATH_MINIMAP_COLOR = '#8ab6f8'

/** 从模型 id 提取短名（去 provider 前缀 / 端口段），V2 风格。 */
function shortModelLabel(modelId?: string): string {
  if (!modelId) return ''
  const value = modelId.trim()
  if (!value) return ''
  return value.split('/').pop()?.split(':').pop() ?? value
}

const TooltipCard = styled.div`
  max-width: 460px;
`
const TooltipTitle = styled.div`
  font-weight: bold;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
  padding-bottom: 4px;
`
const TooltipText = styled.div`
  max-height: 280px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-size: 12px;
`

const BranchGraphNode: React.FC<{ data: TreeNodeData }> = ({ data }) => {
  const { t } = useTranslation()
  const isUser = data.role === 'user'
  const onPath = data.isOnActivePath

  const borderColor = onPath
    ? data.isActive
      ? 'var(--color-primary)'
      : PATH_BORDER
    : isUser
      ? 'var(--color-primary)'
      : 'var(--color-border)'
  const bg = onPath
    ? data.isActive
      ? ACTIVE_FILL
      : PATH_FILL
    : isUser
      ? 'rgba(var(--color-primary-rgb), 0.06)'
      : 'transparent'
  const displayName = isUser ? 'USER' : data.modelName || 'ASSISTANT'
  const modelObject = useMemo<Model | undefined>(
    () => (data.modelId ? ({ id: data.modelId, name: data.modelName || data.modelId } as Model) : undefined),
    [data.modelId, data.modelName]
  )
  return (
    <Tooltip
      title={
        <TooltipCard>
          <TooltipTitle>
            {isUser ? t('chat.history.user_node') : data.modelName || t('chat.history.assistant_node')}
            {data.text.length > 0 ? ' · ' + data.text.slice(0, 60) : ''}
          </TooltipTitle>
          {data.text.length > 0 && <TooltipText>{data.text.slice(0, 3000)}</TooltipText>}
        </TooltipCard>
      }
      placement="top"
      color="rgba(0, 0, 0, 0.85)"
      mouseEnterDelay={0.3}>
      <div
        style={{
          width: NODE_W,
          height: NODE_H,
          border: '2px solid ' + borderColor,
          borderRadius: 8,
          background: bg,
          padding: '6px 8px',
          fontSize: 12,
          cursor: 'pointer',
          color: 'var(--color-text)',
          boxShadow: data.isActive ? '0 0 0 2px rgba(var(--color-primary-rgb), 0.25)' : '0 1px 6px rgba(0, 0, 0, 0.06)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxSizing: 'border-box'
        }}>
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 0 }}>
          {isUser ? (
            <Avatar
              size={16}
              icon={<UserOutlined />}
              style={{ background: 'var(--color-primary)', color: '#fff', fontSize: 9, flexShrink: 0 }}
            />
          ) : modelObject ? (
            <ModelAvatar model={modelObject} size={16} />
          ) : (
            <Avatar
              size={16}
              icon={<UserOutlined style={{ transform: 'scaleX(-1)' }} />}
              style={{ background: 'var(--color-text-3)', color: '#fff', fontSize: 9, flexShrink: 0 }}
            />
          )}
          <span
            style={{
              fontSize: 10,
              color: isUser ? 'var(--color-primary)' : 'var(--color-text-3)',
              fontWeight: 'bold',
              letterSpacing: 0.4,
              textTransform: isUser ? 'uppercase' : 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
            title={displayName}>
            {displayName}
          </span>
        </div>
        <p
          style={{
            margin: '4px 0 0',
            flex: 1,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            lineHeight: 1.35,
            fontSize: 11,
            color: 'var(--color-text)',
            wordBreak: 'break-word'
          }}>
          {data.text || (isUser ? t('chat.history.no_messages') : '…')}
        </p>
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
      </div>
    </Tooltip>
  )
}

/**
 * 一个"逻辑轮"在图中对应的流节点集合（沿某个会话的路径展开用）：
 * 共享/合并轮引用祖先会话已建的 unit，自有轮则由本会话创建。
 */
interface FlowUnit {
  userId: string
  replyIds: string[]
}

/**
 * 统一对话树（消息级）：user 与回复独立节点；回复"重新生成"复用同一 user（其下并列出多条回复），
 * 重发/编辑重发开新 user 节点；布局为分层 tidy 树（类 dagre TB）。
 * 数据层消费 conversationModel（loadFamily/originOf）：每个轮都先解析到内容 origin
 * （copy-prefix 会话共享祖先轮，截断后继等 parentless 会话拥有全部轮次），
 * 再以 origin 去重建节点 —— 多层重发/删除后血缘仍能合并为同一棵树，不再按"副本容器"猜测。
 * 活跃链（起点→选中位置）整条以统一淡蓝填充；缩略图同步标色。
 */
const BranchGraph: React.FC<BranchGraphProps> = ({
  rootTopicId,
  activeTopicId,
  branchKinds,
  refreshKey,
  onOpenBranch
}) => {
  const { t } = useTranslation()
  const { settedTheme } = useTheme()
  const { family, loading } = useConversationTree(rootTopicId, refreshKey ?? '')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const build = useCallback(() => {
    const flowNodes: Node[] = []
    const flowEdges: Edge[] = []
    const edgeSet = new Set<string>()
    const created = new Set<string>()
    // sessionId → 该会话路径上逐轮的流单元（共享/合并轮引用祖先已建单元）
    const chains = new Map<string, FlowUnit[]>()
    if (!family) return { flowNodes, flowEdges }

    const addEdge = (source: string, target: string, kind: 'user-reply' | 'chain'): void => {
      const key = source + '->' + target
      if (edgeSet.has(key)) return
      edgeSet.add(key)
      flowEdges.push({
        id: key,
        source,
        target,
        type: 'smoothstep',
        style: {
          stroke: kind === 'chain' ? 'var(--color-primary)' : 'var(--color-border)',
          strokeWidth: kind === 'chain' ? 1.6 : 1.2
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: kind === 'chain' ? 'var(--color-primary)' : 'var(--color-border)'
        },
        animated: false
      })
    }

    const addUserNode = (sessionId: string, index: number, text: string): string => {
      const id = sessionId + ':u' + index
      if (created.has(id)) return id
      created.add(id)
      flowNodes.push({
        id,
        type: 'branchNode',
        data: {
          nodeId: id,
          sessionId,
          role: 'user',
          turnIndex: index,
          text,
          isActive: sessionId === activeTopicId,
          isOnActivePath: false
        } satisfies TreeNodeData,
        position: { x: 0, y: 0 },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        width: NODE_W,
        height: NODE_H
      })
      return id
    }

    const addReplyNode = (
      sessionId: string,
      index: number,
      replyIndex: number,
      reply: { text: string; modelId?: string; provider?: string },
      ownerUser: string
    ): string => {
      const id = sessionId + ':a' + index + ':' + replyIndex
      if (created.has(id)) return id
      created.add(id)
      flowNodes.push({
        id,
        type: 'branchNode',
        data: {
          nodeId: id,
          sessionId,
          role: 'assistant',
          turnIndex: index,
          text: reply.text,
          isActive: sessionId === activeTopicId,
          isOnActivePath: false,
          ...(reply.modelId ? { modelId: reply.modelId } : {}),
          ...(reply.provider ? { provider: reply.provider } : {}),
          modelName: shortModelLabel(reply.modelId) || undefined
        } satisfies TreeNodeData,
        position: { x: 0, y: 0 },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        width: NODE_W,
        height: NODE_H
      })
      addEdge(ownerUser, id, 'user-reply')
      return id
    }

    // 父先于子（loadFamily 保留内核 BFS 顺序）：子会话解析共享/合并轮时父链已就绪
    for (const session of family.sessions) {
      const parentChain = session.parentTopicId ? chains.get(session.parentTopicId) : undefined
      // 防御：共享段截到父链可引用的前缀（正常血缘下 shared ≤ 父轮数恒成立）
      const shared = parentChain ? Math.min(session.shared, parentChain.length) : 0
      const chain: FlowUnit[] = []
      for (let index = 0; index < session.turns.length; index += 1) {
        let unit: FlowUnit
        if (index < shared && parentChain && parentChain[index] !== undefined) {
          // 复制轮：直接引用祖先（内容 origin 归属）已建的单元，绝不重复建节点
          unit = parentChain[index] as FlowUnit
        } else if (
          index === shared &&
          parentChain !== undefined &&
          branchKinds?.[session.id] === 'regenerate' &&
          parentChain[index] !== undefined
        ) {
          // 重新生成：把本条回复挂到父链同位置的"提问"节点下（该节点可能已一路合并到祖先）
          const ownerUser = (parentChain[index] as FlowUnit).userId
          const replies = session.turns[index].replies
          const replyIds = replies.map((reply, replyIndex) =>
            addReplyNode(session.id, index, replyIndex, reply, ownerUser)
          )
          unit = { userId: ownerUser, replyIds }
        } else {
          // 自有轮：按内容 origin 建/取用户节点（重发等自身新轮在此开新节点）
          const origin = originOf(family, session.id, index)
          if (origin === null) {
            console.warn('[BranchGraph] unresolved origin ' + session.id + ':' + index + ', treating as own turn')
          }
          const userId = addUserNode(session.id, index, session.turns[index].text)
          const replies = session.turns[index].replies
          const replyIds = replies.map((reply, replyIndex) =>
            addReplyNode(session.id, index, replyIndex, reply, userId)
          )
          unit = { userId, replyIds }
        }
        chain.push(unit)
        if (index > 0) {
          const prev = chain[index - 1] as FlowUnit
          if (prev.userId !== unit.userId) {
            const prevLast =
              prev.replyIds.length > 0 ? (prev.replyIds[prev.replyIds.length - 1] as string) : prev.userId
            addEdge(prevLast, unit.userId, 'chain')
          }
        }
      }
      chains.set(session.id, chain)
    }

    // 活跃链：起点 → 当前选中位置（活跃会话整条 unit 链上的 user 与回复）
    const activePathIds = new Set<string>()
    if (activeTopicId) {
      const activeChain = chains.get(activeTopicId)
      if (activeChain) {
        for (const unit of activeChain) {
          activePathIds.add(unit.userId)
          for (const replyId of unit.replyIds) activePathIds.add(replyId)
        }
      }
    }
    for (const node of flowNodes) {
      if (activePathIds.has(node.id)) {
        const data = node.data as unknown as TreeNodeData
        data.isOnActivePath = true
      }
    }

    // ---- 分层 tidy 树布局（类 dagre TB） ----
    const childrenOf = new Map<string, string[]>()
    const parentOf = new Map<string, string>()
    for (const edge of flowEdges) {
      const list = childrenOf.get(edge.source) ?? []
      list.push(edge.target)
      childrenOf.set(edge.source, list)
      parentOf.set(edge.target, edge.source)
    }

    // 点击语义：从所选节点起，始终沿“左子树”（childrenOf 顺序 = 布局自左向右 = 最早创建路径）
    // 的第一子节点逐级下探到底 —— 打开的是那条一直延续到最新叶子所属的会话，
    // 而不是“选到那就到哪”（自己所属会话的终点，通常缺了下方经后代分支延续的对话）。
    const sessionOfNode = new Map(flowNodes.map((node) => [node.id, (node.data as unknown as TreeNodeData).sessionId]))
    const bottomCache = new Map<string, string>()
    const bottomOf = (id: string): string => {
      const cached = bottomCache.get(id)
      if (cached !== undefined) return cached
      const kids = childrenOf.get(id) ?? []
      const bottom = kids.length > 0 ? bottomOf(kids[0] as string) : id
      bottomCache.set(id, bottom)
      return bottom
    }
    for (const node of flowNodes) {
      const data = node.data as unknown as TreeNodeData
      const bottomId = bottomOf(node.id)
      const bottomSession = sessionOfNode.get(bottomId)
      if (bottomSession !== undefined && bottomSession !== data.sessionId) {
        data.openSessionId = bottomSession
      }
    }
    const roots = flowNodes.filter((node) => !parentOf.has(node.id)).map((node) => node.id)
    const nodeIds = flowNodes.map((node) => node.id)

    const rankOf = new Map<string, number>()
    const rankVisiting = new Set<string>()
    const computeRank = (id: string): number => {
      const cached = rankOf.get(id)
      if (cached !== undefined) return cached
      if (rankVisiting.has(id)) return 0 // 环保护（理论不应出现）
      rankVisiting.add(id)
      const parent = parentOf.get(id)
      const rank = parent === undefined ? 0 : computeRank(parent) + 1
      rankVisiting.delete(id)
      rankOf.set(id, rank)
      return rank
    }
    for (const id of nodeIds) computeRank(id)

    const leafOrder: string[] = []
    const visit = (id: string): void => {
      const kids = childrenOf.get(id) ?? []
      if (kids.length === 0) {
        leafOrder.push(id)
        return
      }
      for (const kid of kids) visit(kid)
    }
    for (const root of roots) visit(root)
    const leafSlot = new Map<string, number>()
    leafOrder.forEach((id, index) => leafSlot.set(id, index))

    const xSlot = new Map<string, number>()
    const resolveX = (id: string): number => {
      const cached = xSlot.get(id)
      if (cached !== undefined) return cached
      const kids = childrenOf.get(id) ?? []
      let value: number
      if (kids.length === 0) {
        value = leafSlot.get(id) ?? 0
      } else {
        let min = Number.POSITIVE_INFINITY
        let max = Number.NEGATIVE_INFINITY
        for (const kid of kids) {
          const slot = resolveX(kid)
          min = Math.min(min, slot)
          max = Math.max(max, slot)
        }
        value = (min + max) / 2
      }
      xSlot.set(id, value)
      return value
    }
    for (const id of nodeIds) resolveX(id)

    for (const node of flowNodes) {
      const slot = xSlot.get(node.id) ?? 0
      const rank = rankOf.get(node.id) ?? 0
      node.position = {
        x: 40 + slot * SLOT_W + (SLOT_W - NODE_W) / 2,
        y: 40 + rank * (NODE_H + RANK_SEP)
      }
    }

    return { flowNodes, flowEdges }
  }, [family, activeTopicId, branchKinds])

  useEffect(() => {
    const { flowNodes, flowEdges } = build()
    setNodes(flowNodes)
    setEdges(flowEdges)
  }, [build, setNodes, setEdges])

  const nodeTypes = useMemo(() => ({ branchNode: BranchGraphNode }), [])

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const data = node.data as unknown as TreeNodeData
      const target = data?.openSessionId || data?.sessionId
      if (target) onOpenBranch(target)
    },
    [onOpenBranch]
  )

  if (loading) {
    return (
      <Center>
        <Spin size="large" />
      </Center>
    )
  }
  if (!family || family.sessions.length === 0 || nodes.length === 0) {
    return (
      <Center>
        <Empty description={t('chat.history.no_messages')} />
      </Center>
    )
  }

  return (
    <FlowBox>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.25, minZoom: 0.2, maxZoom: 1.2 }}
          minZoom={0.1}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          colorMode={settedTheme}>
          <Controls showInteractive={false} />
          <MiniMap
            nodeStrokeWidth={3}
            zoomable
            pannable
            nodeColor={(node) => {
              const d = node.data as unknown as TreeNodeData
              if (d?.isOnActivePath) return PATH_MINIMAP_COLOR
              return d?.role === 'user' ? 'var(--color-primary)' : 'var(--color-icon)'
            }}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </FlowBox>
  )
}

const Center = styled.div`
  width: 100%;
  height: 100%;
  min-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
`
const FlowBox = styled.div`
  width: 100%;
  height: 100%;
  min-height: 420px;
`

export default memo(BranchGraph)
