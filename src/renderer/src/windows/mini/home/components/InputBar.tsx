import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import type { Assistant } from '@renderer/types'
import React, { useRef } from 'react'
import styled from 'styled-components'

interface InputBarProps {
  text: string
  assistant: Assistant
  placeholder: string
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

/**
 * 快捷助手输入条。
 * 用原生 input 而非 antd Input：避免 antd autoFocus/受控组件在弹窗内反复抢焦点的怪癖。
 * 聚焦统一由 HomeWindow 通过 ref 主动控制（窗口显示 / 发送后），本组件不自动抢焦点。
 */
const InputBar = ({
  ref,
  text,
  assistant,
  placeholder,
  handleKeyDown,
  handleChange
}: InputBarProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <InputWrapper ref={ref}>
      {assistant.model && <ModelAvatar model={assistant.model} size={30} />}
      <Input
        ref={inputRef}
        value={text}
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        spellCheck={false}
      />
    </InputWrapper>
  )
}
InputBar.displayName = 'InputBar'

const InputWrapper = styled.div`
  display: flex;
  align-items: center;
  margin-top: 10px;
`

const Input = styled.input`
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  -webkit-app-region: none;
  color: var(--color-text);
  font-size: 18px;
  line-height: 24px;
  padding: 4px 0;
  &::placeholder {
    color: var(--color-text-3);
  }
`

export default InputBar
