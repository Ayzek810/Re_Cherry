// fork 缝：V2 `@cherrystudio/ui` 的 4 个原语替身（fork 无 packages/ui）。
// 用法与 V2 一致（组合式 `Popover` + `PopoverTrigger` + `PopoverContent`），内部把整棵
// 子树拆成"首个直接子节点 = 触发器、其余 = 内容"再挂到 antd Popover 上——这是为了
// 不改 V2 调用形态；antd 本身是 content-prop 式。
import { cn } from '@renderer/utils/style'
import { Popover as AntPopover } from 'antd'
import type { ButtonHTMLAttributes, FC, HTMLAttributes, PropsWithChildren, ReactElement, ReactNode } from 'react'
import { Children, cloneElement, isValidElement } from 'react'

type CherryButtonVariant = 'ghost' | 'default' | 'outline' | 'secondary' | 'destructive' | 'link'
type CherryButtonSize = 'sm' | 'default' | 'lg' | 'icon' | 'icon-sm'

interface CherryButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: CherryButtonVariant
  size?: CherryButtonSize
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'] | string
  /** V2 调用方可能传 antd 风格 icon/loading：icon 落成子节点，loading 仅禁用。 */
  icon?: ReactNode
  loading?: boolean
}

/** shadcn 变体语义（取值照 V2 packages/ui 的 button 变体）。 */
const VARIANT_CLASSES: Record<CherryButtonVariant, string> = {
  ghost: 'bg-transparent hover:bg-accent hover:text-accent-foreground',
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline'
}

/** shadcn 尺寸语义。 */
const SIZE_CLASSES: Record<CherryButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2 text-xs',
  default: 'h-9 gap-1.5 px-4 py-2 text-sm',
  lg: 'h-10 gap-1.5 px-6 text-sm',
  icon: 'size-9',
  'icon-sm': 'size-7'
}

/**
 * `@cherrystudio/ui` Button → **原生 button** + 变体/尺寸类。
 * fork 缝：早期这里映射到 antd `Button`，但 antd 的 `.ant-btn`（CSS-in-JS 运行时注入，
 * 晚于 Tailwind 层）会**覆盖 V2 写在按钮上的尺寸/形状类**（h-7 / size-7.5 / h-11…），
 * 表现为控件缩水、卡片塌成默认尺寸（v0.3.3-4 模板轮播卡事故）。V2 的 shadcn Button
 * 本就是"原生 button + 类名"，故这里对齐原生，antd 只留 Popover。
 * fork 缝：A8 —— V2 的 shadcn Button 带 `focus-visible:ring-2 focus-visible:ring-ring`；fork 只剩
 * `focus-visible:outline-none`，键盘聚焦时没有任何可见反馈（WCAG 2.4.7）。补回 ring（`--color-ring` 已在
 * `assets/styles/tailwind.css` 的 @theme 里，`ring-*` 颜色工具类可生成）。
 */
export const Button: FC<CherryButtonProps> = ({
  variant = 'default',
  size = 'default',
  type = 'button',
  icon,
  loading,
  className,
  children,
  disabled,
  ...props
}) => (
  <button
    type={type as ButtonHTMLAttributes<HTMLButtonElement>['type']}
    disabled={disabled || loading === true}
    className={cn(
      'inline-flex cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
      VARIANT_CLASSES[variant],
      SIZE_CLASSES[size],
      className
    )}
    {...props}>
    {icon}
    {children}
  </button>
)

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

/** antd Popover 的 placement 取值。 */
type AntPopoverPlacement =
  | 'top'
  | 'topLeft'
  | 'topRight'
  | 'bottom'
  | 'bottomLeft'
  | 'bottomRight'
  | 'left'
  | 'leftTop'
  | 'leftBottom'
  | 'right'
  | 'rightTop'
  | 'rightBottom'

/**
 * fork 缝：A7 —— V2 的 Popover 是 Radix（`side` + `align` 两个轴 3×4 组合），antd Popover 只有一个
 * `placement`，此前替身把 `align`/`side` 解构丢弃、也没给 `placement` → 参数面板一律落在 antd 默认的
 * `top` 居中位，而 V2 的调用点写的是 `align="start" side="top"`（左边缘对齐）。这里按 Radix 语义换算：
 * align 描述内容与触发点在哪条边上对齐 —— start=左/上边、end=右/下边、center=居中。
 * 只传 `align`/`side` 时才给 `placement`：两轴都缺省时保持 antd 默认，避免改动其它既有调用点。
 */
function getAntdPopoverPlacement(align?: 'start' | 'center' | 'end', side?: 'top' | 'bottom' | 'left' | 'right') {
  if (align === undefined && side === undefined) return undefined
  const resolvedSide = side ?? 'top'
  const resolvedAlign = align ?? 'center'
  if (resolvedSide === 'top' || resolvedSide === 'bottom') {
    const suffix = resolvedAlign === 'start' ? 'Left' : resolvedAlign === 'end' ? 'Right' : ''
    return `${resolvedSide}${suffix}` as AntPopoverPlacement
  }
  const suffix = resolvedAlign === 'start' ? 'Top' : resolvedAlign === 'end' ? 'Bottom' : ''
  return `${resolvedSide}${suffix}` as AntPopoverPlacement
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
  // fork 缝：A7 —— 内容面板声明的 `align`/`side` 只写在这个元素上（`PopoverContent` 不渲染它们），
  // 必须在拆分后读出、换算成 antd 的 `placement`，否则 V2 的对齐信息到此为止。
  const contentProps = isValidElement(content) ? (content.props as CherryPopoverContentProps) : undefined
  const placement = getAntdPopoverPlacement(contentProps?.align, contentProps?.side)

  return (
    <AntPopover
      trigger="click"
      arrow={false}
      placement={placement}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      content={content}>
      {trigger}
    </AntPopover>
  )
}
