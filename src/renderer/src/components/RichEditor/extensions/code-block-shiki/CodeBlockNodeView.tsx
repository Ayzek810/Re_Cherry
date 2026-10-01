import { CopyOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { DEFAULT_LANGUAGES, getHighlighter, getShiki } from '@renderer/utils/shiki'
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from '@tiptap/react'
import { Button, Select, Tooltip } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('RichEditorCodeBlockNodeView')

const CodeBlockNodeView: FC<ReactNodeViewProps> = (props) => {
  const { node, updateAttributes } = props
  const { t } = useTranslation()
  const [languageOptions, setLanguageOptions] = useState<string[]>(DEFAULT_LANGUAGES)

  // Detect language from node attrs or fallback
  const language = (node.attrs.language as string) || 'text'

  // Build language options with 'text' always available
  useEffect(() => {
    const loadLanguageOptions = async () => {
      try {
        const shiki = await getShiki()
        const highlighter = await getHighlighter()

        // Get bundled languages from shiki
        const bundledLanguages = Object.keys(shiki.bundledLanguages)

        // Combine with loaded languages
        const loadedLanguages = highlighter.getLoadedLanguages()

        const allLanguages = Array.from(new Set(['text', ...bundledLanguages, ...loadedLanguages]))

        setLanguageOptions(allLanguages)
      } catch {
        setLanguageOptions(DEFAULT_LANGUAGES)
      }
    }

    void loadLanguageOptions()
  }, [])

  // Handle language change
  const handleLanguageChange = useCallback(
    (value: string) => {
      updateAttributes({ language: value })
    },
    [updateAttributes]
  )

  // Handle copy code block content
  // 原来把剪贴板失败完全吞掉（catch 里连日志都没有），成功也没有任何反馈——
  // 失败与成功不可区分。对照 `CodeBlockView/view.tsx:142-147` 的既有范式：记日志 + 双信号。
  const handleCopy = useCallback(async () => {
    const codeText = props.node.textContent || ''
    try {
      await navigator.clipboard.writeText(codeText)
      window.toast.success(t('code_block.copy.success'))
    } catch (error) {
      logger.error('Failed to copy code block content:', error as Error)
      window.toast.error(t('code_block.copy.failed'))
    }
  }, [props.node.textContent, t])

  return (
    <NodeViewWrapper className="code-block-wrapper">
      <div className="code-block-header">
        <Select
          size="small"
          className="code-block-language-select"
          value={language}
          onChange={handleLanguageChange}
          options={languageOptions.map((lang) => ({ value: lang, label: lang }))}
          style={{ minWidth: 90 }}
        />
        <Tooltip title={t('common.copy')}>
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            className="code-block-copy-btn"
            onClick={handleCopy}
          />
        </Tooltip>
      </div>
      <pre className={`language-${language}`}>
        {/* TipTap will render the editable code content here */}
        <NodeViewContent<'code'> as="code" />
      </pre>
    </NodeViewWrapper>
  )
}

export const CodeBlockNodeReactRenderer = ReactNodeViewRenderer(CodeBlockNodeView)

export default CodeBlockNodeView
