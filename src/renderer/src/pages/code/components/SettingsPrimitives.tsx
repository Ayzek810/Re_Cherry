import type { FC, HTMLAttributes } from 'react'

import { cn } from '@renderer/utils/style'

// fork 缝（批次4b 原创缝模块）：V2 @renderer/components/SettingsPrimitives 的本页消费子集
//（SettingContainer/SettingGroup/SettingTitle —— ConfigEditDialogBody/OwnLoginConfigPanel 两处）。
// V2 的 theme prop（ThemeMode → data-theme-mode）与 SettingGroup 的 card/plain 变体底色在本页
// 消费点全为 variant="plain" + transparent 背景，fork 无该主题面——theme 接收不消费，plain 形状
// 固化（视觉保真度批次 5 视真机效果再调）。

export const SettingContainer: FC<HTMLAttributes<HTMLDivElement> & { theme?: unknown }> = ({
  className,
  theme,
  ...props
}) => {
  void theme
  return <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4', className)} {...props} />
}

export const SettingGroup: FC<HTMLAttributes<HTMLDivElement> & { theme?: unknown; variant?: 'card' | 'plain' }> = ({
  className,
  style,
  theme,
  variant = 'card',
  ...props
}) => {
  void theme
  return (
    <div
      style={{ backgroundColor: variant === 'card' ? 'var(--settings-group-background, var(--card))' : undefined, ...style }}
      className={cn(
        'mb-2.5 rounded-lg border border-2 border-transparent px-1.5 pb-1.5 pt-0.5',
        variant === 'card' ? 'border-border-subtle' : '',
        className
      )}
      {...props}
    />
  )
}

export const SettingTitle: FC<HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('flex select-none items-center justify-between text-[15px] font-semibold', className)} {...props} />
)
