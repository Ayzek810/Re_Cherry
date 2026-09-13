// 通用工具组件 - 减少重复代码
// v0.3.0 Step 2：流式输入/输出辅助件随死分支移除（统一卡由 ToolContent 承担），
// 这里保留卡片共用的状态类型与状态指示器。

import { LoadingIcon } from '@renderer/components/Icons'
import { Check, TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export { default as ToolHeader, type ToolHeaderProps } from '../ToolHeader'

// ToolStatus extends MCPToolResponseStatus with UI-derived statuses
// 'waiting' is a UI status derived from 'pending' + needs approval
export type ToolStatus = 'pending' | 'streaming' | 'invoking' | 'waiting' | 'done' | 'error' | 'cancelled'

// 工具状态指示器 - 显示在 Collapse 标题右侧
export function ToolStatusIndicator({ status, hasError = false }: { status: ToolStatus; hasError?: boolean }) {
  const { t } = useTranslation()

  const getStatusInfo = (): { label: string; icon: ReactNode; color: StatusColor } | null => {
    switch (status) {
      case 'streaming':
        return { label: t('message.tools.streaming', 'Streaming'), icon: <LoadingIcon />, color: 'primary' }
      case 'waiting':
        return { label: t('message.tools.pending', 'Awaiting Approval'), icon: <LoadingIcon />, color: 'warning' }
      case 'pending':
      case 'invoking':
        return { label: t('message.tools.invoking'), icon: <LoadingIcon />, color: 'primary' }
      case 'cancelled':
        return {
          label: t('message.tools.cancelled'),
          icon: <X size={13} className="lucide-custom" />,
          color: 'error'
        }
      case 'done':
        return hasError
          ? {
              label: t('message.tools.error'),
              icon: <TriangleAlert size={13} className="lucide-custom" />,
              color: 'warning'
            }
          : {
              label: t('message.tools.completed'),
              icon: <Check size={13} className="lucide-custom" />,
              color: 'success'
            }
      case 'error':
        return {
          label: t('message.tools.error'),
          icon: <TriangleAlert size={13} className="lucide-custom" />,
          color: 'warning'
        }
      default:
        return null
    }
  }

  const info = getStatusInfo()
  if (!info) return null

  return (
    <StatusIndicatorContainer $color={info.color}>
      {info.label}
      {info.icon}
    </StatusIndicatorContainer>
  )
}

export type StatusColor = 'primary' | 'success' | 'warning' | 'error'

function getStatusColor(color: StatusColor): string {
  switch (color) {
    case 'primary':
    case 'success':
      return 'var(--color-primary)'
    case 'warning':
      return 'var(--color-status-warning, #faad14)'
    case 'error':
      return 'var(--color-status-warning, #faad14)'
    default:
      return 'var(--color-text)'
  }
}

export const StatusIndicatorContainer = styled.span<{ $color: StatusColor }>`
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
  color: ${(props) => getStatusColor(props.$color)} !important;

  svg {
    color: currentColor !important;
    stroke: currentColor !important;
  }
`
