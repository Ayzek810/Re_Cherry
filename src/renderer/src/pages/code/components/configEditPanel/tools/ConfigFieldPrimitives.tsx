import { Select as AntSelect } from 'antd'
import type { ReactNode } from 'react'

import { cn } from '@renderer/utils/style'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/tools/
// ConfigFieldPrimitives.tsx（2026-09-24，v0.3.4-1 批次4b）。缝点两处：
// ① UI 面缝：V2 Radix 组合式 Select（SelectTrigger/SelectValue/SelectContent/SelectItem）改写为
//   antd Select props 式——受控 open/onOpenChange 保留（ConfigSelectField 的外点关闭监听逻辑
//   由 antd 自带行为替代后移除）；UNSET 哨兵语义逐字保留。
// ② Field/ConfigSelectOption/ConfigSelectField 的对外形状逐字（消费面：DeepSeekHarnessConfigFields）。

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 flex-1', className)}>
      <span className="mb-1 block text-[10px] text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export interface ConfigSelectOption {
  value: string
  label: string
}

const UNSET_SELECT_VALUE = '__cherry_unset__'

export function ConfigSelectField({
  label,
  value,
  placeholder,
  options,
  unsetLabel,
  onChange,
  className
}: {
  label: string
  value?: string
  placeholder?: string
  options: ConfigSelectOption[]
  unsetLabel?: string
  onChange: (value: string | undefined) => void
  className?: string
}) {
  const selectOptions = unsetLabel ? [{ value: UNSET_SELECT_VALUE, label: unsetLabel }, ...options] : options

  return (
    <Field label={label} className={cn('max-w-56 flex-none', className)}>
      <AntSelect
        className="h-8 w-full"
        aria-label={label}
        size="small"
        value={value ?? (unsetLabel ? UNSET_SELECT_VALUE : undefined)}
        placeholder={placeholder}
        options={selectOptions}
        onChange={(nextValue) => {
          onChange(nextValue === UNSET_SELECT_VALUE ? undefined : nextValue)
        }}
      />
    </Field>
  )
}
