import { Select as AntdSelect } from 'antd'

import type { PaintingFieldComponentProps } from '../fieldRegistry'
import { resolveOptions } from '../resolveOptions'

// 原语 antd 化：V2 @cherrystudio/ui Select → antd Select（分组经 OptGroup，平铺经 options 数组）。
export default function SelectField({
  item,
  fieldKey,
  painting,
  translate,
  onChange,
  currentValue,
  disabled
}: PaintingFieldComponentProps) {
  const options = resolveOptions(item, painting, translate)
  const grouped = options.some((option) => Array.isArray(option.options) && option.options.length > 0)
  const value = currentValue !== undefined && currentValue !== null ? String(currentValue) : ''
  const ariaLabel = item.title ? translate(item.title) : fieldKey

  if (grouped) {
    return (
      <AntdSelect
        disabled={disabled}
        value={value || undefined}
        placeholder={ariaLabel}
        aria-label={ariaLabel}
        className="w-full"
        onChange={(nextValue) => onChange({ [fieldKey]: nextValue })}>
        {options.map((group) => (
          <AntdSelect.OptGroup key={group.title || group.label} label={group.label || group.title}>
            {group.options?.map((option) => (
              <AntdSelect.Option key={`${fieldKey}-${option.value}`} value={String(option.value)}>
                {option.label}
              </AntdSelect.Option>
            ))}
          </AntdSelect.OptGroup>
        ))}
      </AntdSelect>
    )
  }

  return (
    <AntdSelect
      disabled={disabled}
      value={value || undefined}
      placeholder={ariaLabel}
      aria-label={ariaLabel}
      className="w-full"
      onChange={(nextValue) => onChange({ [fieldKey]: nextValue })}
      options={options.map((option) => ({
        value: String(option.value),
        label: option.label
      }))}
    />
  )
}
