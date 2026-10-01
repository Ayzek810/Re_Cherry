import { InputNumber } from 'antd'
import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

export interface EditableNumberProps {
  value?: number | null
  min?: number
  max?: number
  step?: number
  precision?: number
  placeholder?: string
  disabled?: boolean
  changeOnBlur?: boolean
  onChange?: (value: number | null) => void
  onBlur?: () => void
  style?: React.CSSProperties
  className?: string
  size?: 'small' | 'middle' | 'large'
  suffix?: string
  prefix?: string
  align?: 'start' | 'center' | 'end'
  formatter?: (value: number | null) => string | number
}

const EditableNumber: FC<EditableNumberProps> = ({
  value,
  min,
  max,
  step = 0.01,
  precision,
  placeholder,
  disabled = false,
  onChange,
  onBlur,
  changeOnBlur = false,
  style,
  className,
  size = 'middle',
  align = 'end',
  formatter
}) => {
  const [isEditing, setIsEditing] = useState(false)
  const [inputValue, setInputValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  // Enter 会手动 blur，紧随其后的真实 blur 事件仍会到达 handleBlur，
  // 于是调用方的 onBlur 被通知两次（典型后果：重复提交）。用 ref 去重。
  const isEditingRef = useRef(false)

  useEffect(() => {
    setInputValue(value)
  }, [value])

  const handleFocus = () => {
    if (disabled) return
    isEditingRef.current = true
    setIsEditing(true)
  }

  const handleInputChange = (newValue: number | null) => {
    onChange?.(newValue ?? null)
  }

  const handleBlur = () => {
    if (!isEditingRef.current) return
    isEditingRef.current = false
    setIsEditing(false)
    onBlur?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Enter 不会让 <InputNumber> 失焦；显式 blur 才能把「提交」这一步走完。
      e.preventDefault()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setInputValue(value)
      isEditingRef.current = false
      setIsEditing(false)
    }
  }

  return (
    <Container>
      <InputNumber
        // 非编辑态原来只是 `opacity: 0` —— 仍占布局、仍可被 Tab 聚焦、仍接收键盘输入
        // （上层 DisplayText 只挡指针事件）。改用 `visibility: hidden` + tabIndex={-1}：
        // 视觉与交互都真正关闭。
        style={{ ...style, opacity: isEditing ? 1 : 0, visibility: isEditing ? 'visible' : 'hidden' }}
        ref={inputRef}
        value={inputValue}
        min={min}
        max={max}
        step={step}
        precision={precision}
        size={size}
        tabIndex={isEditing ? 0 : -1}
        onChange={handleInputChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        className={className}
        controls={isEditing}
        changeOnBlur={changeOnBlur}
      />
      <DisplayText style={style} className={className} $align={align} $isEditing={isEditing}>
        {formatter ? formatter(value ?? null) : (value ?? placeholder)}
      </DisplayText>
    </Container>
  )
}

const Container = styled.div`
  display: inline-block;
  position: relative;
`

const DisplayText = styled.div<{
  $align: 'start' | 'center' | 'end'
  $isEditing: boolean
}>`
  position: absolute;
  inset: 0;
  display: ${({ $isEditing }) => ($isEditing ? 'none' : 'flex')};
  align-items: center;
  justify-content: ${({ $align }) => $align};
  pointer-events: none;
`

export default EditableNumber
