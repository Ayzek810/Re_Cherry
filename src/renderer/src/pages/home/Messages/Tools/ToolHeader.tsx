import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { Flex, Tooltip } from 'antd'
import { Wrench } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { type ToolStatus, ToolStatusIndicator } from './MessageAgentTools/GenericTools'
import { getToolDisplay, mapBlockStatusToToolStatus } from './toolDisplay'

export interface ToolHeaderProps {
  block?: ToolMessageBlock

  toolName?: string
  icon?: ReactNode
  params?: ReactNode
  stats?: ReactNode

  // Common config
  status?: ToolStatus
  hasError?: boolean
  showStatus?: boolean // default true
}

const getToolDescription = (block?: ToolMessageBlock): string | undefined => {
  const args = block?.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined

  // Common description fields
  return (args.description || args.file_path || args.pattern || args.query || args.command || args.url)?.toString()
}

// ============ Styled Components ============

// 组内行形态（唯一形态，v0.3.1：standalone 单卡随 ToolBlock 退役）：
// 无边框/内边距，供 Collapse 头与组内行使用
const LabelContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 100%;
  font-size: 13px;
  line-height: 14px;
  min-width: 0;
  height: 38px;

  .tool-name {
    gap: 0 !important;
    line-height: 14px;
  }

  .tool-icon {
    width: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
`

const ToolName = styled(Flex)`
  font-weight: 500;
  color: var(--color-text);
  flex-shrink: 0;

  .tool-icon {
    color: var(--color-primary);
  }

  .name {
    white-space: nowrap;
  }
`

const Description = styled.span`
  color: var(--color-text-2);
  font-weight: 400;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
  max-width: 300px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  text-align: left;
`

const Stats = styled.span`
  color: var(--color-text-2);
  font-weight: 400;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
`

const StatusWrapper = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
`

// ============ Main Component ============

const ToolHeader: FC<ToolHeaderProps> = ({
  block,
  toolName: propToolName,
  icon: propIcon,
  params,
  stats,
  status: propStatus,
  hasError: propHasError,
  showStatus = true
}) => {
  const { t } = useTranslation()

  const resolvedName = propToolName || block?.toolName || 'Tool'
  const display = getToolDisplay(resolvedName)
  const toolName = display.labelKey !== undefined ? t(display.labelKey) : resolvedName

  const status = propStatus ?? mapBlockStatusToToolStatus(block?.status ?? MessageBlockStatus.PROCESSING, false)
  const hasError = propHasError ?? block?.status === MessageBlockStatus.ERROR

  const description = params ?? getToolDescription(block)

  return (
    <LabelContainer>
      <ToolName className="tool-name" align="center" gap={6}>
        <Tooltip title={resolvedName !== toolName ? resolvedName : undefined} mouseLeaveDelay={0}>
          <span className="tool-icon">{propIcon || display.icon || <Wrench size={14} />}</span>
        </Tooltip>
        <span className="name">{toolName}</span>
      </ToolName>
      {description && <Description>{description}</Description>}
      {stats && <Stats>{stats}</Stats>}
      {showStatus && status && (
        <StatusWrapper>
          <ToolStatusIndicator status={status} hasError={hasError} />
        </StatusWrapper>
      )}
    </LabelContainer>
  )
}

export default memo(ToolHeader)
