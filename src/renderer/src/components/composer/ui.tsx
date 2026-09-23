// fork 缝：V2 `@cherrystudio/ui` 的 4 个原语替身（fork 无 packages/ui）。
// 用法与 V2 一致（组合式 `Popover` + `PopoverTrigger` + `PopoverContent`），内部把整棵
// 子树拆成"首个直接子节点 = 触发器、其余 = 内容"再挂到 antd Popover 上——这是为了
// 不改 V2 调用形态；antd 本身是 content-prop 式。
import type { ButtonProps } from 'antd'
import { Button as AntButton, Popover as AntPopover } from 'antd'
import type { ButtonHTMLAttributes, FC, HTMLAttributes, PropsWithChildren, ReactElement, ReactNode } from 'react'
import { Children, cloneElement, isValidElement } from 'react'

type CherryButtonVariant = 'ghost' | 'default' | 'outline' | 'secondary' | 'destructive' | 'link'
type CherryButtonSize = 'sm' | 'default' | 'lg' | 'icon' | 'icon-sm'

/** antd 的 ButtonHTMLAttributes 允许 button/submit/reset；V2 调用方传字符串字面量。 */
interface CherryButtonProps extends Omit<ButtonProps, 'size' | 'variant' | 'type'> {
  variant?: CherryButtonVariant
  size?: CherryButtonSize
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'] | string
}

const ANTD_BUTTON_SIZE: Record<CherryButtonSize, ButtonProps['size']> = {
  sm: 'small',
  default: 'middle',
  lg: 'large',
  icon: 'small',
  'icon-sm': 'small'
}

/** `@cherrystudio/ui` Button → antd Button（variant 的视觉差异由调用方 className 承载）。 */
export const Button: FC<CherryButtonProps> = ({ variant, size = 'default', type = 'button', ...props }) => {
  void variant
  return <AntButton type={type as ButtonProps['type']} size={ANTD_BUTTON_SIZE[size]} {...props} />
}

/**
 * V2 的 `asChild` 触发器：把 antd 注入的触发 props（onClick/onMouseEnter…）**透传给唯一子节点**。
 * antd 的 Popover 用 cloneElement 把 handler 挂到它直接收到的子元素上——即挂到本替身组件上；
 * 若像早期版本那样只 `return <>{children}</>`，handler 会被吞掉、弹层点不开（静态门禁照不出来）。
 */
export const PopoverTrigger: FC<PropsWithChildren<{ asChild?: boolean } & HTMLAttributes<HTMLElement>>> = ({
  children,
  asChild,
  ...rest
}) => {
  void asChild
  const child = Children.only(children)
  if (!isValidElement(child)) return <>{children}</>
  return cloneElement(child as ReactElement<Record<string, unknown>>, rest as Record<string, unknown>)
}

interface CherryPopoverContentProps extends PropsWithChildren {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

interface CherryPopoverProps extends PropsWithChildren {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

/** 内容面板：antd 会把它放进 `ant-popover-content`，这里只提供 V2 的 className 容器。 */
export const PopoverContent: FC<CherryPopoverContentProps> = ({ children, className }) => (
  <div className={className}>{children}</div>
)

/**
 * V2 组合式 Popover：`children` 里触发器之外的部分即内容。调用顺序固定
 * （PopoverTrigger → PopoverContent），这里按"首个直接子节点为触发器"拆分。
 */
export const Popover: FC<CherryPopoverProps> = ({ children, open, defaultOpen, onOpenChange }) => {
  const parts = Children.toArray(children)
  const [trigger, ...rest] = parts
  const content: ReactNode = rest.length === 1 ? rest[0] : rest

  return (
    <AntPopover
      trigger="click"
      arrow={false}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      content={content}>
      {trigger}
    </AntPopover>
  )
}
