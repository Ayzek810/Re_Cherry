import type { Editor } from '@tiptap/core'
import { Tooltip } from 'antd'
import type { TFunction } from 'i18next'
import type { LucideProps } from 'lucide-react'
import type { ForwardRefExoticComponent, RefAttributes } from 'react'
import React, { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getCommandsByGroup, subscribeCommandRegistry } from './command'
import { ImageUploader } from './components/ImageUploader'
import MathInputDialog from './components/MathInputDialog'
import { ToolbarButton, ToolbarDivider, ToolbarWrapper } from './styles'
import type { FormattingCommand, FormattingState, ToolbarProps } from './types'

interface ToolbarItemInternal {
  id: string
  command?: FormattingCommand
  icon?: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>
  type?: 'divider'
  /**
   * 动态命令自己的执行体（`Command.handler`）。
   * c2-20：原实现把它包成 `() => cmd.handler` 存在 `handler` 字段里，而**没有任何地方读取它**，
   * 于是「注册了工具栏命令、但没给 `formattingCommand`」的命令点下去什么也不做。
   */
  run?: (editor: Editor) => void
  /** 动态命令的可读名（`Command.title`），用作 tooltip 兜底。 */
  label?: string
}

// Group ordering for toolbar layout
const TOOLBAR_GROUP_ORDER = ['formatting', 'text', 'blocks', 'structure', 'media', 'history']

function getToolbarItems(): ToolbarItemInternal[] {
  const items: ToolbarItemInternal[] = []

  TOOLBAR_GROUP_ORDER.forEach((groupName, groupIndex) => {
    const groupCommands = getCommandsByGroup(groupName)

    if (groupCommands.length > 0 && groupIndex > 0) {
      items.push({ id: `divider-${groupIndex}`, type: 'divider' })
    }

    groupCommands.forEach((cmd) => {
      items.push({
        id: cmd.id,
        command: cmd.formattingCommand as FormattingCommand | undefined,
        icon: cmd.icon,
        run: cmd.handler,
        label: cmd.title
      })
    })
  })

  return items
}

// Function to get tooltip text for toolbar commands
const getTooltipText = (t: TFunction, command: FormattingCommand): string => {
  const tooltipMap: Record<FormattingCommand, string> = {
    bold: t('richEditor.toolbar.bold'),
    italic: t('richEditor.toolbar.italic'),
    underline: t('richEditor.toolbar.underline'),
    strike: t('richEditor.toolbar.strike'),
    code: t('richEditor.toolbar.code'),
    clearMarks: t('richEditor.toolbar.clearMarks'),
    paragraph: t('richEditor.toolbar.paragraph'),
    heading1: t('richEditor.toolbar.heading1'),
    heading2: t('richEditor.toolbar.heading2'),
    heading3: t('richEditor.toolbar.heading3'),
    heading4: t('richEditor.toolbar.heading4'),
    heading5: t('richEditor.toolbar.heading5'),
    heading6: t('richEditor.toolbar.heading6'),
    bulletList: t('richEditor.toolbar.bulletList'),
    orderedList: t('richEditor.toolbar.orderedList'),
    codeBlock: t('richEditor.toolbar.codeBlock'),
    taskList: t('richEditor.toolbar.taskList'),
    blockquote: t('richEditor.toolbar.blockquote'),
    link: t('richEditor.toolbar.link'),
    undo: t('richEditor.toolbar.undo'),
    redo: t('richEditor.toolbar.redo'),
    table: t('richEditor.toolbar.table'),
    image: t('richEditor.toolbar.image'),
    blockMath: t('richEditor.toolbar.blockMath'),
    inlineMath: t('richEditor.toolbar.inlineMath')
  }

  return tooltipMap[command] || command
}

export const Toolbar: React.FC<ToolbarProps> = memo(function Toolbar({
  editor,
  formattingState,
  onCommand,
  scrollContainer
}) {
  const { t } = useTranslation()
  const [showImageUploader, setShowImageUploader] = useState(false)
  const [showMathInput, setShowMathInput] = useState(false)
  // c2-21：命令注册表是模块级可变的，工具栏条目按注册表版本号记忆化——
  // 没有它时每次按键重渲染都会重建整排按钮（约 24 个按钮 + 19 个 Tooltip）。
  const [registryVersion, setRegistryVersion] = useState(0)
  const [placeholderCallbacks, setPlaceholderCallbacks] = useState<{
    onMathSubmit?: (latex: string) => void
    onMathCancel?: () => void
    onMathFormulaChange?: (formula: string) => void
    mathDefaultValue?: string
    mathPosition?: { x: number; y: number; top: number }
    onImageSelect?: (imageUrl: string) => void
    onImageCancel?: () => void
  }>({})

  // Listen for custom events from placeholder nodes
  useEffect(() => {
    const handleMathDialog = (event: CustomEvent) => {
      const { defaultValue, onSubmit, onFormulaChange, position } = event.detail
      setPlaceholderCallbacks((prev) => ({
        ...prev,
        onMathSubmit: onSubmit,
        onMathCancel: () => {},
        onMathFormulaChange: onFormulaChange,
        mathDefaultValue: defaultValue,
        mathPosition: position
      }))
      setShowMathInput(true)
    }

    const handleImageUploader = (event: CustomEvent) => {
      const { onImageSelect, onCancel } = event.detail
      setPlaceholderCallbacks((prev) => ({ ...prev, onImageSelect, onImageCancel: onCancel }))
      setShowImageUploader(true)
    }

    window.addEventListener('openMathDialog', handleMathDialog as EventListener)
    window.addEventListener('openImageUploader', handleImageUploader as EventListener)

    return () => {
      window.removeEventListener('openMathDialog', handleMathDialog as EventListener)
      window.removeEventListener('openImageUploader', handleImageUploader as EventListener)
    }
  }, [])

  useEffect(() => subscribeCommandRegistry(() => setRegistryVersion((version) => version + 1)), [])

  // c2-21：命令注册表是模块级可变的，工具栏条目按注册表版本号记忆化。
  // 这个 useMemo 必须在下面那条 `if (!editor)` 早退**之前**：放在早退之后就变成条件 Hook，
  // editor 从 null 变为实例时 Hook 数量变化，React 直接抛「Rendered more hooks than during
  // the previous render」。回调体不读 registryVersion，它只是失效键。
  const toolbarItems = useMemo(() => getToolbarItems(), [registryVersion])

  if (!editor) {
    return null
  }

  const handleCommand = (command: FormattingCommand) => {
    if (command === 'image') {
      editor.chain().focus().insertImagePlaceholder().run()
    } else if (command === 'blockMath') {
      editor.chain().focus().insertMathPlaceholder({ mathType: 'block' }).run()
    } else if (command === 'inlineMath') {
      editor.chain().focus().insertMathPlaceholder({ mathType: 'inline' }).run()
    } else {
      onCommand(command)
    }
  }

  const handleImageSelect = (imageUrl: string) => {
    if (editor) {
      editor.chain().focus().setImage({ src: imageUrl }).run()
    }
    setShowImageUploader(false)
  }

  return (
    <ToolbarWrapper data-testid="rich-editor-toolbar">
      {toolbarItems.map((item) => {
        if (item.type === 'divider') {
          return <ToolbarDivider key={item.id} />
        }

        const Icon = item.icon
        const command = item.command
        const runCommand = item.run

        if (!Icon || (!command && !runCommand)) {
          return null
        }

        const isActive = command ? getFormattingState(formattingState, command) : false
        const isDisabled = command ? getDisabledState(formattingState, command) : false
        const tooltipText = command ? getTooltipText(t, command) : item.label || item.id

        const buttonElement = (
          <ToolbarButton
            $active={isActive}
            data-active={isActive}
            disabled={isDisabled}
            onClick={() => (command ? handleCommand(command) : runCommand?.(editor))}
            data-testid={`toolbar-${command ?? item.id}`}
            aria-label={tooltipText}
            aria-pressed={isActive}>
            <Icon color={isActive ? 'var(--color-primary)' : 'var(--color-text)'} />
          </ToolbarButton>
        )

        return (
          <Tooltip key={item.id} title={tooltipText} placement="top">
            {buttonElement}
          </Tooltip>
        )
      })}
      <ImageUploader
        visible={showImageUploader}
        onImageSelect={(imageUrl) => {
          if (placeholderCallbacks.onImageSelect) {
            placeholderCallbacks.onImageSelect(imageUrl)
            setPlaceholderCallbacks((prev) => ({ ...prev, onImageSelect: undefined, onImageCancel: undefined }))
          } else {
            handleImageSelect(imageUrl)
          }
          setShowImageUploader(false)
        }}
        onClose={() => {
          if (placeholderCallbacks.onImageCancel) {
            placeholderCallbacks.onImageCancel()
            setPlaceholderCallbacks((prev) => ({ ...prev, onImageSelect: undefined, onImageCancel: undefined }))
          }
          setShowImageUploader(false)
        }}
      />
      <MathInputDialog
        visible={showMathInput}
        defaultValue={placeholderCallbacks.mathDefaultValue || ''}
        position={placeholderCallbacks.mathPosition}
        scrollContainer={scrollContainer}
        onSubmit={(formula) => {
          if (placeholderCallbacks.onMathSubmit) {
            placeholderCallbacks.onMathSubmit(formula)
          } else {
            if (editor && formula.trim()) {
              editor.chain().focus().insertBlockMath({ latex: formula }).run()
            }
          }
          setPlaceholderCallbacks((prev) => ({
            ...prev,
            onMathSubmit: undefined,
            onMathCancel: undefined,
            onMathFormulaChange: undefined,
            mathDefaultValue: undefined,
            mathPosition: undefined
          }))
          setShowMathInput(false)
        }}
        onCancel={() => {
          if (placeholderCallbacks.onMathCancel) {
            placeholderCallbacks.onMathCancel()
            setPlaceholderCallbacks((prev) => ({
              ...prev,
              onMathSubmit: undefined,
              onMathCancel: undefined,
              onMathFormulaChange: undefined,
              mathDefaultValue: undefined,
              mathPosition: undefined
            }))
          }
          setShowMathInput(false)
        }}
        onFormulaChange={(formula) => {
          if (placeholderCallbacks.onMathFormulaChange) {
            placeholderCallbacks.onMathFormulaChange(formula)
          } else {
            if (editor) {
              const mathNodeType = editor.schema.nodes.inlineMath || editor.schema.nodes.blockMath
              if (mathNodeType === editor.schema.nodes.inlineMath) {
                editor.chain().updateInlineMath({ latex: formula }).run()
              } else if (mathNodeType === editor.schema.nodes.blockMath) {
                editor.chain().updateBlockMath({ latex: formula }).run()
              }
            }
          }
        }}
      />
    </ToolbarWrapper>
  )
})

Toolbar.displayName = 'RichEditorToolbar'

function getFormattingState(state: FormattingState, command: FormattingCommand): boolean {
  switch (command) {
    case 'bold':
      return state?.isBold || false
    case 'italic':
      return state?.isItalic || false
    case 'underline':
      return state?.isUnderline || false
    case 'strike':
      return state?.isStrike || false
    case 'code':
      return state?.isCode || false
    case 'paragraph':
      return state?.isParagraph || false
    case 'heading1':
      return state?.isHeading1 || false
    case 'heading2':
      return state?.isHeading2 || false
    case 'heading3':
      return state?.isHeading3 || false
    case 'heading4':
      return state?.isHeading4 || false
    case 'heading5':
      return state?.isHeading5 || false
    case 'heading6':
      return state?.isHeading6 || false
    case 'bulletList':
      return state?.isBulletList || false
    case 'orderedList':
      return state?.isOrderedList || false
    case 'codeBlock':
      return state?.isCodeBlock || false
    case 'blockquote':
      return state?.isBlockquote || false
    case 'link':
      return state?.isLink || false
    case 'table':
      return state?.isTable || false
    case 'taskList':
      return state?.isTaskList || false
    case 'blockMath':
      return state?.isMath || false
    case 'inlineMath':
      return state?.isInlineMath || false
    default:
      return false
  }
}

function getDisabledState(state: FormattingState, command: FormattingCommand): boolean {
  switch (command) {
    case 'bold':
      return !state?.canBold
    case 'italic':
      return !state?.canItalic
    case 'underline':
      return !state?.canUnderline
    case 'strike':
      return !state?.canStrike
    case 'code':
      return !state?.canCode
    case 'undo':
      return !state?.canUndo
    case 'redo':
      return !state?.canRedo
    case 'clearMarks':
      return !state?.canClearMarks
    case 'link':
      return !state?.canLink
    case 'table':
      return !state?.canTable
    case 'image':
      return !state?.canImage
    case 'blockMath':
      return !state?.canMath
    case 'inlineMath':
      return !state?.canMath
    default:
      return false
  }
}
