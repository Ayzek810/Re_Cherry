/**
 * 图标按钮（V2 components/IconButton.tsx 薄适配）：尺寸/色调语义逐字保留，
 * 仅把 V2 的 NormalTooltip 换成 antd Tooltip。
 */
import { cn } from '@renderer/utils/style'
import { Tooltip } from 'antd'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type IconButtonSize = 'xs' | 'sm' | 'md'
export type IconButtonTone = 'ghost' | 'destructive'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: IconButtonSize
  tone?: IconButtonTone
  active?: boolean
  tooltip?: ReactNode
}

const SIZE_CLASS: Record<IconButtonSize, string> = {
  xs: 'h-4 w-4 rounded-md',
  sm: 'h-6 w-6 rounded-md',
  md: 'h-7 w-7 rounded-md'
}

const toneClass = (tone: IconButtonTone, active: boolean): string => {
  if (tone === 'destructive') {
    return 'text-muted-foreground hover:bg-accent hover:text-destructive'
  }
  return active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
}

const IconButton = ({ size = 'sm', tone = 'ghost', active = false, className, type, tooltip, ...rest }: Props) => {
  const tooltipContent = tooltip ?? rest['aria-label']
  const button = (
    <button
      type={type ?? 'button'}
      className={cn(
        'flex shrink-0 items-center justify-center transition-colors',
        'focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        SIZE_CLASS[size],
        toneClass(tone, active),
        className
      )}
      {...rest}
    />
  )

  if (!tooltipContent || rest.disabled) {
    return button
  }

  return <Tooltip title={tooltipContent}>{button}</Tooltip>
}

export default IconButton
