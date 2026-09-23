/**
 * 左栏输入面板（V2 components/TranslateInputPane.tsx 结构，OCR/文件支路按 fork 范围删除）：
 * 只有 textarea；空态即 placeholder。Ctrl/Cmd+Enter 的按键语义由页面注入的 onKeyDown 决定。
 */
import type { FC, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  text: string
  onTextChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  disabled: boolean
}

const TranslateInputPane: FC<Props> = ({ text, onTextChange, onKeyDown, disabled }) => {
  const { t } = useTranslation()

  return (
    <div
      data-ui="translate.input"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <textarea
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        spellCheck={false}
        placeholder={t('translate.input_placeholder')}
        className="min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent p-4 text-base text-foreground leading-relaxed outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />
    </div>
  )
}

export default TranslateInputPane
