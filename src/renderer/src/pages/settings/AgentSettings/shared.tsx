import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import EmojiIcon from '@renderer/components/EmojiIcon'
import type { Assistant } from '@renderer/types'
import { cn } from '@renderer/utils'
import type { ModalProps } from 'antd'
import { Menu, Modal } from 'antd'
import type { ReactNode } from 'react'
import React from 'react'
import styled from 'styled-components'

import { SettingDivider } from '..'

/**
 * 智能体设置弹窗的共享外壳零件（移植自 Cherry Studio V1 AgentSettings/shared.tsx，
 * 数据实体改为 Redux 的 Assistant；去掉 V1 特有的 soul-mode / agents-db 类型）。
 */

export interface SettingsTitleProps extends React.ComponentPropsWithRef<'div'> {
  contentAfter?: ReactNode
}

export const SettingsTitle: React.FC<SettingsTitleProps> = ({ children, contentAfter }) => {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className="flex items-center gap-1 font-bold">{children}</span>
      {contentAfter !== undefined && contentAfter}
    </div>
  )
}

export type AgentLabelProps = {
  assistant: Assistant | undefined | null
  classNames?: {
    container?: string
    avatar?: string
    name?: string
  }
  hideIcon?: boolean
}

/** 弹窗标题：助手标识（单路径，AssistantAvatar）+ 名称；无助手时兜底 ⭐️。 */
export const AgentLabel = ({ assistant, classNames, hideIcon }: AgentLabelProps) => {
  return (
    <div className={cn('flex w-full items-center gap-2 truncate', classNames?.container)}>
      {!hideIcon &&
        (assistant ? (
          <AssistantAvatar assistant={assistant} className={classNames?.avatar} size={24} />
        ) : (
          <EmojiIcon emoji="⭐️" className={classNames?.avatar} size={24} />
        ))}
      <span className={cn('truncate', 'text-(--color-text)', classNames?.name)}>{assistant?.name ?? ''}</span>
    </div>
  )
}

export interface SettingsItemProps extends React.ComponentPropsWithRef<'div'> {
  /** Add a divider beneath the item if true, defaults to true. */
  divider?: boolean
  /** Apply row direction flex or not, defaults to false. */
  inline?: boolean
}

export const SettingsItem: React.FC<SettingsItemProps> = ({
  children,
  divider = true,
  inline = false,
  className,
  ...props
}) => {
  return (
    <>
      <div
        {...props}
        className={cn('flex flex-col', inline ? 'flex-row items-center justify-between gap-4' : undefined, className)}>
        {children}
      </div>
      {divider && <SettingDivider />}
    </>
  )
}

export const SettingsContainer: React.FC<React.ComponentPropsWithRef<'div'>> = ({ children, className, ...props }) => {
  return (
    <div className={cn('flex-1 overflow-y-auto p-4', className)} {...props}>
      {children}
    </div>
  )
}

export const LeftMenu = styled.div`
  height: 100%;
  border-right: 0.5px solid var(--color-border);
`

export const Settings = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

export const StyledModal = styled(Modal)`
  .ant-modal-title {
    font-size: 14px;
  }
  .ant-modal-close {
    top: 4px;
    right: 4px;
  }
  .ant-menu-item {
    height: 36px;
    color: var(--color-text-2);
    display: flex;
    align-items: center;
    border: 0.5px solid transparent;
    border-radius: 6px;
    .ant-menu-title-content {
      line-height: 36px;
    }
  }
  .ant-menu-item-active {
    background-color: var(--color-background-soft) !important;
    transition: none;
  }
  .ant-menu-item-selected {
    background-color: var(--color-background-soft);
    border: 0.5px solid var(--color-border);
    .ant-menu-title-content {
      color: var(--color-text-1);
      font-weight: 500;
    }
  }
`

export const StyledMenu = styled(Menu)`
  width: 220px;
  padding: 5px;
  background: transparent;
  margin-top: 2px;
  .ant-menu-item {
    margin-bottom: 7px;
  }
`

/** Shared modal styles configuration for settings popups. */
export const settingsModalStyles: ModalProps['styles'] = {
  content: {
    padding: 0,
    overflow: 'hidden',
    height: '80vh',
    display: 'flex',
    flexDirection: 'column'
  },
  header: {
    padding: '10px 15px',
    paddingRight: '32px',
    borderBottom: '0.5px solid var(--color-border)',
    margin: 0,
    borderRadius: 0
  },
  body: {
    padding: 0,
    display: 'flex',
    flex: 1
  }
}
