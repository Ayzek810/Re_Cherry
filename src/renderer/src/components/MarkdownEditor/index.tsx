import 'katex/dist/katex.min.css'

import DOMPurify from 'dompurify'
import type { FC } from 'react'
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import styled from 'styled-components'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  height?: string | number
  autoFocus?: boolean
}

/**
 * 预览链上有 `rehypeRaw`（原始 HTML 会变成真实节点树），却没有任何 sanitize。
 * 这里用仓库既有的 `dompurify`（`utils/export.ts`、`Preview/utils.ts` 同款）在交给 ReactMarkdown
 * 之前先净化**含 HTML 的**源码；纯 Markdown（不含 `<`）原样透传，避免改动数学/表格等语法。
 */
const sanitizeMarkdownSource = (source: string): string => (source.includes('<') ? DOMPurify.sanitize(source) : source)

const MarkdownEditor: FC<MarkdownEditorProps> = ({
  value,
  onChange,
  placeholder,
  height = '300px',
  autoFocus = false
}) => {
  const { t } = useTranslation()
  const [inputValue, setInputValue] = useState(value || '')

  useEffect(() => {
    setInputValue(value || '')
  }, [value])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setInputValue(newValue)
    onChange(newValue)
  }

  const sanitizedValue = useMemo(() => sanitizeMarkdownSource(inputValue), [inputValue])
  const resolvedPlaceholder =
    placeholder ?? t('settings.provider.notes.markdown_editor_placeholder', 'Enter Markdown text...')

  return (
    <EditorContainer style={{ height }}>
      <InputArea value={inputValue} onChange={handleChange} placeholder={resolvedPlaceholder} autoFocus={autoFocus} />
      <PreviewArea className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkMath]}
          rehypePlugins={[rehypeRaw, rehypeKatex]}>
          {sanitizedValue || t('settings.provider.notes.markdown_editor_default_value')}
        </ReactMarkdown>
      </PreviewArea>
    </EditorContainer>
  )
}

const EditorContainer = styled.div`
  display: flex;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  width: 100%;
`

const InputArea = styled.textarea`
  flex: 1;
  padding: 12px;
  border: none;
  resize: none;
  font-family: var(--font-family);
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text);
  background-color: var(--color-bg-1);
  border-right: 1px solid var(--color-border);
  outline: none;

  &:focus {
    outline: none;
  }

  &::placeholder {
    color: var(--color-text-3);
  }
`

const PreviewArea = styled.div`
  flex: 1;
  padding: 12px;
  overflow: auto;
  background-color: var(--color-bg-1);
`

export default MarkdownEditor
