// fork 缝（批次4b 原创缝模块）：V2 `@cherrystudio/ui` 的本页消费面替身（fork 无 packages/ui）。
// shim 面以 V2 pages/code/**.tsx 的实际 import 为准（grep 汇总）：Button、Tooltip、NormalTooltip、
// Dialog/DialogContent/DialogHeader/DialogTitle/DialogFooter/DialogDescription、ConfirmDialog、
// Alert、SearchInput、EmptyState、ReorderableList、CodeEditor、Scrollbar、Input。
// V2 的 Select 组合式（Select*）与 SegmentedControl 消费点（CurrentConfigPanel / ConfigFieldPrimitives）
// 直接改写为 antd Select props 式，不进本表；Checkbox 只被未移植的 tools/ClaudeConfigFields 使用，不造。
// 形状/命名风格照 components/composer/ui.tsx 先例（painting 批次 shim）。
//
// 视觉缝：V2 的 shadcn className 串原样保留（fork 的 Tailwind @theme 已含 background/foreground/
// border-subtle/foreground-tertiary/accent 等语义令牌）；V2 复合状态色令牌（success-border /
// success-subtle / warning-subtle / error-* 族）fork 未暴露，消费点以 success/warning/error 的
// 透明度修饰（/35 /15）降级——视觉保真度批次 5 视真机效果再调。
import { Alert as AntAlert, Empty as AntEmpty, Input as AntInput, Modal as AntModal, Tooltip as AntTooltip } from 'antd'
import { RadioTower, Search } from 'lucide-react'
import type {
  ButtonHTMLAttributes,
  ChangeEvent,
  CSSProperties,
  FC,
  HTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref
} from 'react'
import { createContext, useContext } from 'react'

import ForkCodeEditor from '@renderer/components/CodeEditor'
import ForkScrollbar from '@renderer/components/Scrollbar'
import { cn } from '@renderer/utils/style'

// fork 缝：V2 `@cherrystudio/ui` Button → 原生 button + 变体/尺寸类（照 composer/ui.tsx 先例：
// antd Button 的 CSS-in-JS 运行时注入会覆盖 V2 写在按钮上的尺寸/形状类）。相对先例补两点：
// ref 直传（ConfigEditDialogBody 的取消钮自动聚焦 / ModelSelectorTrigger 用）、focus ring。
type CherryButtonVariant = 'ghost' | 'default' | 'outline' | 'secondary' | 'destructive' | 'link'
type CherryButtonSize = 'sm' | 'default' | 'lg' | 'icon' | 'icon-sm'

const VARIANT_CLASSES: Record<CherryButtonVariant, string> = {
  ghost: 'bg-transparent hover:bg-accent hover:text-accent-foreground',
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline'
}

const SIZE_CLASSES: Record<CherryButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-md px-3 text-xs',
  default: 'h-9 gap-1.5 rounded-md px-4 py-2 text-sm',
  lg: 'h-10 gap-1.5 rounded-md px-6 text-sm',
  icon: 'size-9 rounded-md',
  'icon-sm': 'size-7 rounded-md'
}

interface CherryButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: CherryButtonVariant
  size?: CherryButtonSize
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'] | string
  /** V2 调用方传 antd 风格 loading：仅禁用（V2 自带自绘 spinner 时不传）。 */
  loading?: boolean
  ref?: Ref<HTMLButtonElement>
}

export const Button: FC<CherryButtonProps> = ({
  variant = 'default',
  size = 'default',
  type = 'button',
  loading,
  className,
  children,
  disabled,
  ref,
  ...props
}) => (
  <button
    ref={ref}
    type={type as ButtonHTMLAttributes<HTMLButtonElement>['type']}
    disabled={disabled || loading === true}
    className={cn(
      'inline-flex cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
      VARIANT_CLASSES[variant],
      SIZE_CLASSES[size],
      className
    )}
    {...props}>
    {children}
  </button>
)

// fork 缝：V2 Tooltip/NormalTooltip → antd Tooltip。content/title 双名并收（V2 两处调用形态
// 不同）；side/sideOffset 的 Radix 偏移轴无 antd 对应面，降级为 antd 默认定位。
interface CherryTooltipProps {
  content?: ReactNode
  title?: ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** V2 毫秒延迟 → antd mouseEnterDelay（秒）。 */
  delay?: number
  delayDuration?: number
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
  children?: ReactNode
}

export const Tooltip: FC<CherryTooltipProps> = ({ content, title, placement = 'top', delay = 0, children }) => (
  <AntTooltip title={content ?? title} placement={placement} mouseEnterDelay={delay / 1000}>
    {children}
  </AntTooltip>
)

export const NormalTooltip: FC<CherryTooltipProps> = ({
  content,
  placement = 'top',
  side,
  delayDuration = 0,
  children
}) => (
  <AntTooltip
    title={content}
    placement={side ?? placement}
    mouseEnterDelay={delayDuration / 1000}
    arrow={false}>
    {children}
  </AntTooltip>
)

// fork 缝：V2 Dialog 组合式 → antd Modal。Dialog 只做 open/onOpenChange 上下文，DialogContent
// 承载 Modal 本体（V2 的 size → Modal 宽度；onOpenAutoFocus/aria-describedby 无 antd 对应面，
// 接收不消费——取消钮自动聚焦行为降级）；Header/Title/Footer/Description 为普通容器，
// footer 类名保留 V2 串（Modal footer=null）。
interface CherryDialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}

interface DialogContextValue {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const DialogContext = createContext<DialogContextValue>({})

export const Dialog: FC<CherryDialogProps> = ({ open, onOpenChange, children }) => (
  <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>
)

type CherryDialogContentSize = 'default' | 'lg'

interface CherryDialogContentProps extends HTMLAttributes<HTMLDivElement> {
  size?: CherryDialogContentSize
  'aria-describedby'?: string
  onOpenAutoFocus?: (event: Event) => void
}

export const DialogContent: FC<CherryDialogContentProps> = ({
  size = 'default',
  className,
  children,
  ...rest
}) => {
  void rest
  const { open, onOpenChange } = useContext(DialogContext)
  return (
    <AntModal
      open={open}
      onCancel={onOpenChange ? () => onOpenChange(false) : undefined}
      footer={null}
      width={size === 'lg' ? 680 : 520}
      maskClosable
      destroyOnHidden>
      <div className={className}>{children}</div>
    </AntModal>
  )
}

export const DialogHeader: FC<HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props} />
)

export const DialogTitle: FC<HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('text-lg leading-none font-semibold tracking-tight', className)} {...props} />
)

export const DialogDescription: FC<HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('text-muted-foreground text-sm', className)} {...props} />
)

export const DialogFooter: FC<HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
)

// fork 缝：V2 ConfirmDialog → antd Modal 确认件（受控组件；V2 经 removeDialogProps 整包透传）。
// destructive → okButtonProps.danger；description 落在标题下正文。antd 无 cancel 自动归还焦点的
// onOpenAutoFocus 面，行为降级。
interface CherryConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  cancelText?: string
  confirmText?: string
  destructive?: boolean
  confirmLoading?: boolean
  onConfirm: () => void | Promise<void>
}

export const ConfirmDialog: FC<CherryConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  cancelText,
  confirmText,
  destructive,
  confirmLoading,
  onConfirm
}) => (
  <AntModal
    open={open}
    title={title}
    onCancel={() => onOpenChange(false)}
    onOk={onConfirm}
    okText={confirmText}
    cancelText={cancelText}
    okButtonProps={{ danger: destructive }}
    confirmLoading={confirmLoading}>
    {description}
  </AntModal>
)

// fork 缝：V2 Input → antd Input 直通（消费面只有受控 value/onChange/placeholder/readOnly）。
type CherryInputProps = Omit<HTMLAttributes<HTMLInputElement>, 'onChange'> & {
  value?: string | number | readonly string[]
  placeholder?: string
  readOnly?: boolean
  tabIndex?: number
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
}

export const Input: FC<CherryInputProps> = ({ className, ...props }) => (
  <AntInput className={className} {...props} />
)

// fork 缝：V2 SearchInput → antd Input allowClear + 前缀搜索图标。V2 的 onClear/clearLabel 消费点
// （CodeCliContentPanel）由 allowClear 的 onChange('') 通道覆盖，不再单列。
interface CherrySearchInputProps {
  size?: 'sm' | 'default' | 'lg'
  value?: string
  placeholder?: string
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  onClear?: () => void
  clearLabel?: string
}

export const SearchInput: FC<CherrySearchInputProps> = ({
  size = 'default',
  value,
  placeholder,
  onChange,
  onKeyDown,
  onClear,
  clearLabel
}) => {
  void onClear
  void clearLabel
  return (
    <AntInput
      allowClear
      size={size === 'sm' ? 'small' : size === 'lg' ? 'large' : 'middle'}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      onKeyDown={onKeyDown}
      prefix={<Search className="size-3.5 text-muted-foreground" />}
    />
  )
}

// fork 缝：V2 Alert → antd Alert 直通。
interface CherryAlertProps extends HTMLAttributes<HTMLDivElement> {
  type?: 'warning' | 'error' | 'info' | 'success'
  showIcon?: boolean
  description?: ReactNode
}

export const Alert: FC<CherryAlertProps> = ({ type = 'info', showIcon, description, className, children }) => (
  <AntAlert type={type} showIcon={showIcon} description={description ?? children} className={className} />
)

// fork 缝：V2 EmptyState → antd Empty（V2 的 preset 插画族 fork 无对应资产面，接收不消费，
// 统一 antd 默认插画降级）。
interface CherryEmptyStateProps {
  preset?: string
  title?: ReactNode
  description?: ReactNode
}

export const EmptyState: FC<CherryEmptyStateProps> = ({ preset, title, description }) => {
  void preset
  return (
    <AntEmpty
      className="py-8"
      description={
        <div className="space-y-1">
          {title && <div className="text-foreground text-sm">{title}</div>}
          {description && <div className="text-muted-foreground text-xs">{description}</div>}
        </div>
      }
    />
  )
}

// fork 缝：V2 ReorderableList → 顺序列表。拖拽排序未实现（fork 未引入 dnd 面）：items 的顺序
// 即渲染顺序，ConfigList 的 onReorder 通道保留（move-to-top 按钮可用）；dragging 恒 false。
// itemStyle/gap 接收不消费（间距由消费点的 className 决定）。
interface CherryReorderableListProps<T> {
  items: T[]
  visibleItems?: T[]
  getId: (item: T) => string
  onReorder: (nextItems: T[]) => void | Promise<void>
  disabled?: boolean
  gap?: string
  itemStyle?: CSSProperties
  renderItem: (item: T, index: number, state: { dragging: boolean }) => ReactNode
}

export function ReorderableList<T>({
  items,
  visibleItems,
  getId,
  onReorder,
  disabled,
  gap,
  itemStyle,
  renderItem
}: CherryReorderableListProps<T>) {
  void getId
  void onReorder
  void disabled
  void gap
  const shown = visibleItems ?? items
  const indexById = new Map(items.map((item, index) => [item as unknown, index]))
  return (
    <div className="space-y-2" style={itemStyle}>
      {shown.map((item, visibleIndex) => {
        const sourceIndex = indexById.get(item as unknown) ?? visibleIndex
        return (
          <div key={getId(item)} data-dragging={false}>
            {renderItem(item, sourceIndex, { dragging: false })}
          </div>
        )
      })}
    </div>
  )
}

// fork 缝：V2 CodeEditor → fork 既有 CodeEditor（@uiw/react-codemirror 封装，主题走
// CodeStyleProvider）。V2 的 theme 入参（useCmTheme 产物）由 fork 编辑器自取主题替代，接收不消费；
// V2 language 'dotenv' 折射为 fork 语言表可解析的 'properties'（dotenv 无专用 codemirror 语言包），
// 'yaml' 由 @uiw/codemirror-extensions-langs 的 langs.yaml 原生支持。
type CherryCodeEditorLanguage = 'json' | 'yaml' | 'dotenv' | (string & {})

interface CherryCodeEditorOptions {
  autocompletion?: boolean
  lineNumbers?: boolean
  foldGutter?: boolean
  keymap?: boolean
}

interface CherryCodeEditorProps {
  theme?: unknown
  fontSize?: number
  value: string
  language?: CherryCodeEditorLanguage
  onChange?: (value: string) => void
  height?: string
  maxHeight?: string
  expanded?: boolean
  wrapped?: boolean
  options?: CherryCodeEditorOptions
}

export const CodeEditor: FC<CherryCodeEditorProps> = ({
  theme,
  fontSize,
  value,
  language,
  onChange,
  height,
  maxHeight,
  expanded,
  wrapped,
  options
}) => {
  void theme
  return (
    <ForkCodeEditor
      value={value}
      language={language === 'dotenv' ? 'properties' : (language ?? 'json')}
      onChange={onChange}
      fontSize={fontSize}
      height={height}
      maxHeight={maxHeight}
      expanded={expanded}
      wrapped={wrapped}
      options={options}
    />
  )
}

// fork 缝：V2 Scrollbar → fork 既有 Scrollbar（styled div overflow-y:auto）直接复用。
export const Scrollbar = ForkScrollbar

// fork 缝：V2 @renderer/components/icons/GatewayIcon（广播塔塔形 glyph）fork 无该组件——
// 以 lucide RadioTower 等值替代（relay/hub 隐喻保持）。
export const GatewayIcon: FC<{ width?: number; height?: number; className?: string }> = ({
  width,
  height,
  className
}) => <RadioTower width={width ?? 16} height={height ?? 16} className={className} />
