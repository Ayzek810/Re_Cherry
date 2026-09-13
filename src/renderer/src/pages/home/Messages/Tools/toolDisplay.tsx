/**
 * dsh 工具名 → 图标与文案的统一映射（内核真实工具名：read / write / pwsh / ask_user_question …）。
 * 统一工具卡（MessageTools）与 ToolHeader 共用；未登记的名字回退为扳手图标 + 原名。
 */
import { MessageBlockStatus } from '@renderer/types/newMessage'
import {
  FileEdit,
  FileSearch,
  FileText,
  FolderSearch,
  ListTodo,
  MessageCircleQuestion,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { ToolStatus } from './MessageAgentTools/GenericTools'

export interface ToolDisplayInfo {
  icon: ReactNode
  /** i18n key（message.tools.labels.*）；未登记的工具回退显示原名。 */
  labelKey?: string
}

export function getToolDisplay(toolName: string): ToolDisplayInfo {
  switch (toolName) {
    case 'read':
    case 'read_image':
      return { icon: <FileText size={14} />, labelKey: 'message.tools.labels.readFile' }
    case 'write':
      return { icon: <FileText size={14} />, labelKey: 'message.tools.labels.write' }
    case 'edit':
    case 'str_replace_editor':
      return { icon: <FileEdit size={14} />, labelKey: 'message.tools.labels.edit' }
    case 'glob':
      return { icon: <FolderSearch size={14} />, labelKey: 'message.tools.labels.glob' }
    case 'grep':
      return { icon: <FileSearch size={14} />, labelKey: 'message.tools.labels.grep' }
    case 'pwsh':
    case 'bash':
      return { icon: <SquareTerminal size={14} />, labelKey: 'message.tools.labels.bash' }
    case 'job_output':
      return { icon: <ListTodo size={14} />, labelKey: 'message.tools.labels.jobOutput' }
    case 'job_list':
      return { icon: <ListTodo size={14} />, labelKey: 'message.tools.labels.jobList' }
    case 'job_kill':
      return { icon: <ListTodo size={14} />, labelKey: 'message.tools.labels.jobKill' }
    case 'ask_user_question':
      return { icon: <MessageCircleQuestion size={14} />, labelKey: 'message.tools.labels.askUser' }
    default:
      return { icon: <Wrench size={14} /> }
  }
}

export const askUserToolName = 'ask_user_question'

/** 块状态 → 工具卡 UI 状态（含"等待用户批准/作答"派生态）。 */
export function mapBlockStatusToToolStatus(status: MessageBlockStatus, isWaiting: boolean): ToolStatus {
  switch (status) {
    case MessageBlockStatus.STREAMING:
      return 'streaming'
    case MessageBlockStatus.PROCESSING:
      return isWaiting ? 'waiting' : 'invoking'
    case MessageBlockStatus.SUCCESS:
      return 'done'
    case MessageBlockStatus.ERROR:
      return 'error'
    case MessageBlockStatus.PAUSED:
      return 'cancelled'
    default:
      return 'pending'
  }
}
