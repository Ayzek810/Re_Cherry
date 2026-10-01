// fork 缝（原创缝模块）：V2 `@cherrystudio/ui` 的本页消费面替身（fork 无 packages/ui）。
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
// 透明度修饰降级——视觉保真度 视真机效果再调。
import ForkCodeEditor from '@renderer/components/CodeEditor'
import ForkScrollbar from '@renderer/components/Scrollbar'
import { cn } from '@renderer/utils/style'
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
import { createContext, use } from 'react'

import { overallPercent, segmentFills } from '../utils/progressSegments'

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
  <AntTooltip title={content} placement={side ?? placement} mouseEnterDelay={delayDuration / 1000} arrow={false}>
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
  <DialogContext value={{ open, onOpenChange }}>{children}</DialogContext>
)

type CherryDialogContentSize = 'default' | 'lg'

interface CherryDialogContentProps extends HTMLAttributes<HTMLDivElement> {
  size?: CherryDialogContentSize
  'aria-describedby'?: string
  onOpenAutoFocus?: (event: Event) => void
}

export const DialogContent: FC<CherryDialogContentProps> = ({ size = 'default', className, children, ...rest }) => {
  void rest
  const { open, onOpenChange } = use(DialogContext)
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
  <div className={cn('font-semibold text-lg leading-none tracking-tight', className)} {...props} />
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

export const Input: FC<CherryInputProps> = ({ className, ...props }) => <AntInput className={className} {...props} />

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

// fork 缝：V2 ReorderableList → 顺序列表（**无拖拽**）。
//
// 旧实现把 `onReorder/disabled/gap` 显式丢弃（`void onReorder`），却在每张卡片上
// 渲染一个 `cursor-grab` 的拖拽把手、并把 `dragging` 恒置 false——"渲染承诺了交互但语义为空"，
// 用户按住把手拖动毫无反应且没有任何提示。这里按审查给出的降级臂处理：**去掉假通道**，
// 顺序只由消费点常显的"置顶"按钮改变（ConfigList.handleMoveToTop → onReorder 真正生效）。
// 形态保留 V2 的 `{items, visibleItems, getId, renderItem}`：items 的顺序就是渲染顺序，
// visibleItems 是过滤后的可见子集（搜索态下仍能按源顺序取 index）。
interface CherryReorderableListProps<T> {
  items: T[]
  visibleItems?: T[]
  getId: (item: T) => string
  itemStyle?: CSSProperties
  renderItem: (item: T, index: number) => ReactNode
}

export function ReorderableList<T>({
  items,
  visibleItems,
  getId,
  itemStyle,
  renderItem
}: CherryReorderableListProps<T>) {
  const shown = visibleItems ?? items
  const indexById = new Map(items.map((item, index) => [item as unknown, index]))
  return (
    <div className="space-y-2" style={itemStyle}>
      {shown.map((item, visibleIndex) => {
        const sourceIndex = indexById.get(item as unknown) ?? visibleIndex
        return <div key={getId(item)}>{renderItem(item, sourceIndex)}</div>
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

// fork 缝（原创）：进度条作为**本页标准 UI 元素**（与 Button/Tooltip/Alert 同档）。
// 为什么要进本表：进度此前是 VersionStatusCard 里的私有 markup，谁要展示进度都得复制一遍
// 那串 div 与 ARIA 属性——这正是"只有某一家有进度条"的结构性原因。规则集中在本件：
// - `value`（0..100）有值 → 确定性进度条；缺省 → 不确定态（脉冲）——**两者都不许假**；
// - `segments` 有值 → 多段形态：已完成的段满格（事实），当前段按 value 填或脉冲，未到的段留空。
//   安装类长活的硬约束是"执行阶段（pip/npm/vite）没有诚实百分比"——单条进度条在那几分钟里
//   只能装死；分段让"又走完一段"成为可见的推进，且不编造耗时比例；
// - 两种形态都带 `role="progressbar"` 与可读标签；确定态附 aria-valuenow；
// - 宽度变化走 motion-safe 过渡，尊重减少动效偏好。
export interface CherryProgressProps {
  /** 0..100；缺省为不确定态。 */
  value?: number
  /** 无障碍标签 / 主文案。 */
  label: string
  /** 次要事实（语言无关的补充数字）。 */
  detail?: string
  /**
   * 多段形态：总段数与当前段（index 从 1 起）。段与段的权重相等——这是**展示约定**，
   * 不是对各阶段耗时的测量（各段实际时长差几十倍，条因此是"阶段级"而非"时间级"的诚实近似）。
   */
  segments?: { index: number; total: number }
  className?: string
}

/** 条内填充：确定态按宽度填，不确定态脉冲。 */
const ProgressFill: FC<{ percent: number | null }> = ({ percent }) =>
  percent === null ? (
    <div className="h-full w-1/3 rounded-full bg-foreground/50 motion-safe:animate-pulse" />
  ) : (
    <div
      className="h-full rounded-full bg-foreground/60 motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out"
      style={{ width: `${percent}%` }}
    />
  )

export const Progress: FC<CherryProgressProps> = ({ value, label, detail, segments, className }) => {
  const percent =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null
  // 分段算术在 utils/progressSegments.ts（纯函数，单测钉住 1 起/钳制/整体百分比）。
  const fills = segmentFills(segments, percent)
  const overall = overallPercent(segments, percent)
  return (
    <div className={className}>
      {segments ? (
        <div
          className="flex w-full gap-1"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={overall ?? 0}>
          {fills.map((fill, i) => (
            <div key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <ProgressFill percent={fill} />
            </div>
          ))}
        </div>
      ) : (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={label}
          {...(percent === null ? {} : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent })}>
          <ProgressFill percent={percent} />
        </div>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {label}
        {detail ? <span className="ml-1 font-mono">{detail}</span> : null}
      </p>
    </div>
  )
}
