/**
 * 统一工具卡（v0.3.0 Step 2）：所有工具共用同一卡片框架——标题行（图标 + 名称 + 状态）
 * + 内容区（参数 + 输出）。数据直接来自 ToolMessageBlock（内核投影）。
 *
 * 作 ToolBlockGroup 组内行渲染：无自带边框，审批/作答操作由组头部承载（避免重复）。
 * v0.3.1：原 standalone 单卡路径（ToolBlock）退役——孤儿工具调用也走组形态（可收拢），
 * 组内行成为唯一形态。
 */
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import React from 'react'
import styled from 'styled-components'

import { useToolApproval } from './hooks/useToolApproval'
import ToolContent from './ToolContent'
import { mapBlockStatusToToolStatus } from './toolDisplay'
import ToolHeader from './ToolHeader'

interface Props {
  block: ToolMessageBlock
}

const InlineCard = styled.div`
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
`

const MessageTools: React.FC<Props> = ({ block }) => {
  // 审批等待态影响状态指示灯；审批按钮本身在组头部（WaitingToolHeader）
  const approval = useToolApproval(block)
  const status = mapBlockStatusToToolStatus(block.status, approval.isWaiting)

  return (
    <InlineCard>
      <ToolHeader block={block} status={status} hasError={block.status === MessageBlockStatus.ERROR} />
      <ToolContent block={block} />
    </InlineCard>
  )
}

export default React.memo(MessageTools)
