/**
 * 统一工具卡（v0.3.0 Step 2）：所有工具共用同一卡片框架——标题行（图标 + 名称 + 状态）
 * + 内容区（参数 + 输出）+ 审批操作。数据直接来自 ToolMessageBlock（内核投影），
 * 不再依赖 rawMcpToolResponse（其生产者已随 MCP/Agent 子系统移除）。
 *
 * - standalone：单个工具调用（ToolBlock 路径）——自带边框容器，审批按钮挂在标题行右侧。
 * - inline：ToolBlockGroup 组内行——无自带边框，审批/作答操作由组头部承载（避免重复）。
 */
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'

import React from 'react'
import styled from 'styled-components'

import ToolApprovalActionsComponent from './ToolApprovalActions'
import ToolContent from './ToolContent'
import ToolHeader from './ToolHeader'
import { useToolApproval } from './hooks/useToolApproval'
import { mapBlockStatusToToolStatus } from './toolDisplay'

interface Props {
  block: ToolMessageBlock
  variant?: 'standalone' | 'inline'
}

const StandaloneCard = styled.div`
  width: 100%;
  max-width: 100%;
  border: 0.5px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background);
  overflow: hidden;
`

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;

  > .header-main {
    flex: 1 1 auto;
    min-width: 0;
  }

  > .header-actions {
    flex-shrink: 0;
    padding-right: 10px;
  }
`

const InlineCard = styled.div`
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
`

const MessageTools: React.FC<Props> = ({ block, variant = 'standalone' }) => {
  const approval = useToolApproval(block)
  const status = mapBlockStatusToToolStatus(block.status, approval.isWaiting)

  if (variant === 'inline') {
    return (
      <InlineCard>
        <ToolHeader block={block} variant="collapse-label" status={status} hasError={block.status === MessageBlockStatus.ERROR} />
        <ToolContent block={block} />
      </InlineCard>
    )
  }

  return (
    <StandaloneCard>
      <HeaderRow>
        <span className="header-main">
          <ToolHeader
            block={block}
            variant="standalone"
            status={status}
            hasError={block.status === MessageBlockStatus.ERROR}
          />
        </span>
        {(approval.isWaiting || approval.isExecuting) && (
          <span className="header-actions">
            <ToolApprovalActionsComponent {...approval} compact />
          </span>
        )}
      </HeaderRow>
      <ToolContent block={block} />
    </StandaloneCard>
  )
}

export default React.memo(MessageTools)
