// fork 缝：仅实现非 compact 路径（绘画不传 compactWhenSingleLine）。
// 本文件顶替 V2 `components/composer/ComposerSurface.tsx` + `ComposerSurfaceRuntime.tsx`
// 的作曲条外层：结构 / class / 控件 markup 抄自 V2 的对应行号（见各段注释），内核换成
// V2 自带的受控 textarea（V2 ComposerSurface.tsx:252-327）——fork 无 TipTap。
import { QuickPanelReservedSymbol, QuickPanelView, useQuickPanel } from '@renderer/components/QuickPanel'
import { useFileDragDrop } from '@renderer/pages/home/Inputbar/hooks/useFileDragDrop'
import PasteService from '@renderer/services/PasteService'
import QuickPhraseService from '@renderer/services/QuickPhraseService'
import type { QuickPhrase } from '@renderer/types'
import { isSendMessageKeyPressed } from '@renderer/utils/input'
import { cn } from '@renderer/utils/style'
import { Tooltip } from 'antd'
import { CirclePause, Maximize2, Minimize2 } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ComposerToolLauncher,
  ComposerUnifiedPanelControl,
  QuickPanelInputAdapter
} from './quickPanel'
import type { ComposerDraftToken, ComposerSerializedDraft, ComposerSerializedToken } from './tokens'
import { useComposerEditorFrameSizing } from './useComposerEditorFrameSizing'
import { type ComposerAttachment, mergeComposerAttachments } from './variants/shared/composerTokens'

/** V2 ComposerSurfaceRuntime.tsx:91 的 `COMPOSER_SIDE_PADDING_PX` 由 `withSidePadding` 的 `px-6`
 *  class 承载（见下方 narrowLayoutClassName），故此处不再保留该常量。 */

export interface ComposerSurfaceActions {
  focus: (position?: 'start' | 'end' | 'all' | number | boolean | null) => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  replaceDraft: (draft: ComposerSerializedDraft) => void
  toggleExpanded: (nextState?: boolean) => void
  removeToken: (tokenId: string) => void
  insertToken: (token: ComposerDraftToken) => void
  getDraft: () => ComposerSerializedDraft
}

export interface ComposerSurfaceEditingState {
  messageId: string
  highlightKey?: number
  onCancel: () => void
  onLocate?: () => void
  onSave?: (draft: ComposerSerializedDraft) => void | Promise<void>
}

type ComposerSurfaceSendAccessoryRenderer = (
  inputAdapter?: QuickPanelInputAdapter,
  unifiedPanelControl?: ComposerUnifiedPanelControl
) => React.ReactNode

/** V2 ComposerSurfaceRuntime.tsx:139-206 `ComposerSurfaceProps`（删去绘画不传的字段）。 */
export interface ComposerSurfaceProps {
  text: string
  onTextChange: (text: string) => void
  tokens: readonly ComposerDraftToken[]
  managedTokenKinds: readonly ComposerDraftToken['kind'][]
  onTokensChange: (tokens: readonly ComposerSerializedToken[]) => void
  placeholder: string
  sendDisabled: boolean
  sendBlockedReason?: string
  isLoading: boolean
  onSendDraft: (draft: ComposerSerializedDraft, options?: { steer?: boolean }) => void | Promise<void>
  onPause: () => void | Promise<void>
  supportedExts: string[]
  setFiles: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>
  filesCount: number
  isExpanded: boolean
  onExpandedChange: (expanded: boolean) => void
  quickPanelEnabled: boolean
  enableDragDrop: boolean
  enableSpellCheck: boolean
  fontSize: number
  narrowMode: boolean
  onFocus?: () => void
  getToolLaunchers?: () => ComposerToolLauncher[]
  toolLaunchersVersion?: number
  onToolLauncherSelect?: (launcher: ComposerToolLauncher, options: { source: 'popover' | 'root-panel' }) => void
  renderLeftControls?: (
    inputAdapter?: QuickPanelInputAdapter,
    unifiedPanelControl?: ComposerUnifiedPanelControl
  ) => React.ReactNode
  topContent?: React.ReactNode
  leadingContent?: React.ReactNode
  sendAccessory?: React.ReactNode | ComposerSurfaceSendAccessoryRenderer
  queueContent?: React.ReactNode
}

const ComposerSurface = (props: ComposerSurfaceProps) => {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // V2 `useComposerEditorFrameSizing`：只取非 compact 路径需要的高度面。
  const {
    frameRef,
    frameStyle,
    editorContentStyle,
    minHeight,
    maxHeight,
    resizeHandleValue,
    hasCustomHeight,
    startResize,
    handleResizeKeyDown,
    toggleExpanded,
    restoreDefaultHeight
  } = useComposerEditorFrameSizing({
    fontSize: props.fontSize,
    isExpanded: props.isExpanded,
    onExpandedChange: props.onExpandedChange,
    // fork 缝：V2 在 toggleExpanded/restoreDefaultHeight 收尾调 focusEditor()（V2:235/290），
    // 展开/收起后光标回输入框；fork 的编辑元素是本文件的受控 textarea，故接它。
    focusEditor: () => textareaRef.current?.focus()
  })

  const sendBlockedReasonRef = useRef(props.sendBlockedReason)
  useEffect(() => {
    sendBlockedReasonRef.current = props.sendBlockedReason
  }, [props.sendBlockedReason])

  const showBlockedSendReason = useCallback(() => {
    if (sendBlockedReasonRef.current) {
      window.toast.error(sendBlockedReasonRef.current)
    }
  }, [])

  const getDraft = useCallback(
    (): ComposerSerializedDraft => ({
      text: props.text,
      tokens: props.tokens.map((token, index) => ({ ...token, index, textOffset: props.text.length }))
    }),
    [props.text, props.tokens]
  )

  const sendDraft = useCallback(() => {
    void props.onSendDraft(getDraft())
  }, [getDraft, props])

  // fork 缝：V2 的拖拽入图走 TipTap drop 层（按 supportedExts 过滤 + 不支持提示），
  // 这里接 fork 既有的 useFileDragDrop 达到同一语义（过滤 + 提示 + setFiles）。
  const dragDrop = useFileDragDrop({
    supportedExts: props.supportedExts,
    setFiles: props.setFiles,
    enabled: props.enableDragDrop,
    t
  })
  const isDragging = dragDrop.isDragging

  // fork 缝（P0-C）：V2 连纯 textarea 回退都捕获 paste 并把整包交给运行时
  // （V2 ComposerSurface.tsx:282-287），fork 的 textarea 此前没有 onPaste——剪贴板里的
  // 图片因此静默消失。fork 无 TipTap 运行时，改交 fork 既有 PasteService（Inputbar 同源）：
  // 剪贴板含文件时它 event.preventDefault() 并落成 FileMetadata，再经 appendFiles 走与 "+"
  // 同一条规范化路径并入作曲条实时列表；纯文本粘贴它直接返回 false，不拦截（原生插入不变）。
  const appendFiles = useCallback(
    (updater: (prevFiles: ComposerAttachment[]) => ComposerAttachment[]) => {
      props.setFiles((prev) => mergeComposerAttachments(prev, updater(prev)))
    },
    [props]
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // 沿用 PasteService.handlePaste 的既有签名；第 5 位起（长文本转文件等）fork 绘画不启用。
      void PasteService.handlePaste(
        event.nativeEvent,
        props.supportedExts,
        appendFiles,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        t
      )
    },
    [appendFiles, props.supportedExts, t]
  )

  // fork 缝：V2 的 `/` 面板由 ComposerToolMenu 的 launcher 注册（工具注册表），fork 无
  // 该层——这里直接用 fork 的 QuickPanel + QuickPhraseService（已存提示词）接上同一入口。
  const quickPanel = useQuickPanel()
  const [phrases, setPhrases] = useState<QuickPhrase[]>([])
  useEffect(() => {
    if (!props.quickPanelEnabled) return
    let alive = true
    void QuickPhraseService.getAll().then((list) => {
      if (alive) setPhrases(list)
    })
    return () => {
      alive = false
    }
  }, [props.quickPanelEnabled])

  const insertPhrase = useCallback(
    (content: string, range: { start: number; end: number }) => {
      const next = props.text.slice(0, range.start) + content + props.text.slice(range.end)
      props.onTextChange(next)
      const caret = range.start + content.length
      window.setTimeout(() => {
        const input = textareaRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(caret, caret)
      }, 0)
    },
    [props]
  )

  const openPhrasePanel = useCallback(
    (range: { start: number; end: number }) => {
      if (!props.quickPanelEnabled) return
      quickPanel.open({
        title: t('settings.quickPhrase.title'),
        symbol: QuickPanelReservedSymbol.QuickPhrases,
        triggerInfo: { type: 'input', position: range.start },
        list: phrases.map((phrase) => ({
          label: phrase.title,
          description: phrase.content,
          icon: '',
          action: () => insertPhrase(phrase.content, range)
        }))
      })
    },
    [insertPhrase, phrases, props.quickPanelEnabled, quickPanel, t]
  )

  /** 只在 `/` 位于词首时唤起面板（V2 `hasComposerQuickPanelTriggerBoundary` 的等价判定）。 */
  const maybeOpenPhrasePanel = useCallback(
    (value: string, caret: number) => {
      const match = /(^|\s)\/(\S*)$/.exec(value.slice(0, caret))
      if (!match) return
      openPhrasePanel({ start: caret - match[2].length - 1, end: caret })
    },
    [openPhrasePanel]
  )

  const inputAdapter = useMemo<QuickPanelInputAdapter>(
    () => ({
      getInputState: () => ({ text: props.text, position: textareaRef.current?.selectionStart ?? props.text.length }),
      insertText: (value, range) => insertPhrase(value, range ?? { start: props.text.length, end: props.text.length })
    }),
    [insertPhrase, props.text]
  )

  const unifiedPanelControl = useMemo<ComposerUnifiedPanelControl>(
    () => ({
      available: props.quickPanelEnabled,
      open: () => {
        const position = textareaRef.current?.selectionStart ?? props.text.length
        openPhrasePanel({ start: position, end: position })
      }
    }),
    [openPhrasePanel, props.quickPanelEnabled, props.text.length]
  )

  // V2 ComposerSurfaceRuntime.tsx:2093/2096-2113 的发送/暂停动作。
  const showPauseButton = props.isLoading && props.sendDisabled
  const leftControls = props.renderLeftControls?.(inputAdapter, unifiedPanelControl)
  const sendAccessoryElement =
    typeof props.sendAccessory === 'function' ? props.sendAccessory(inputAdapter, unifiedPanelControl) : props.sendAccessory
  const ExpandIcon = hasCustomHeight ? Minimize2 : Maximize2
  const sendAction = showPauseButton ? (
    <Tooltip title={t('chat.input.pause')} placement="top">
      <button
        data-ui="chat.composer.action.pause"
        type="button"
        className="flex size-7.5 items-center justify-center rounded-full text-error hover:bg-accent"
        aria-label={t('chat.input.pause')}
        onClick={() => void props.onPause()}>
        {/* fork 缝：index.css 的 `.lucide:not(.lucide-custom){color:var(--color-icon)}` 会盖掉
            按钮上的 text-error，暂停图标恒为灰色；lucide-custom 是 fork 既有的退出全局灰化约定。 */}
        <CirclePause size={20} className="lucide-custom" />
      </button>
    </Tooltip>
  ) : (
    // fork 缝：V2 的 `<i>` SendMessageButton 原 markup（V2 SendMessageButton.tsx:33-52）；
    // 图标类 `iconfont icon-ic_send` fork 已有，颜色令牌换成 fork 的
    // --color-primary / --color-text-3，并接上 disabled 时的阻断提示回调。
    <i
      data-ui="chat.composer.action.send"
      className="iconfont icon-ic_send"
      onClick={() => (props.sendDisabled ? showBlockedSendReason() : sendDraft())}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (props.sendDisabled) showBlockedSendReason()
        else sendDraft()
      }}
      role="button"
      aria-label={t('chat.input.send')}
      aria-disabled={props.sendDisabled}
      tabIndex={props.sendDisabled ? -1 : 0}
      style={{
        cursor: props.sendDisabled ? 'not-allowed' : 'pointer',
        color: props.sendDisabled ? 'var(--color-text-3)' : 'var(--color-primary)',
        fontSize: 22,
        transition: 'all 0.2s',
        marginTop: 1,
        marginRight: 2
      }}
    />
  )

  const quickPanelElement = props.quickPanelEnabled ? <QuickPanelView setInputText={() => undefined} /> : null

  // V2 ComposerSurfaceRuntime.tsx:2166-2269 `#inputbar`（非 compact 分支）。
  const inputbarElement = (
    <div
      id="inputbar"
      data-ui="chat.composer"
      data-composer-inputbar=""
      data-composer-presentation="regular"
      className={cn(
        'inputbar-container relative rounded-[20px] border-[0.5px] border-border bg-card shadow-sm transition-all duration-200 ease-in-out',
        'pt-2',
        'mb-3',
        isDragging &&
          "border-2 border-success border-dashed before:pointer-events-none before:absolute before:inset-0 before:z-5 before:rounded-[18px] before:bg-success/[0.03] before:content-['']",
        props.isExpanded && 'expanded'
      )}>
      {/* V2:2183-2197 resize 控件。 */}
      <div
        data-composer-resize-handle=""
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={minHeight}
        aria-valuemax={maxHeight}
        aria-valuenow={resizeHandleValue}
        aria-label={t('chat.input.resize_height')}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={handleResizeKeyDown}
        className="group/composer-resize-handle absolute top-0 right-4 left-4 z-3 h-2 cursor-row-resize [-webkit-app-region:no-drag] focus-visible:bg-primary/40 focus-visible:outline-none">
        <div className="absolute top-0 right-0 left-0 h-0.5 rounded-full bg-primary/20 opacity-0 transition-opacity group-hover/composer-resize-handle:opacity-100 group-focus/composer-resize-handle:opacity-100" />
      </div>
      {/* V2:2199-2215 expand 控件（`isExpanded`/`onExpandedChange` 一个开关）。 */}
      <div data-composer-expand-corner="" className="group/expand-corner absolute top-px right-px z-4 size-8">
        <span
          aria-hidden="true"
          data-composer-expand-corner-line=""
          className="pointer-events-none absolute top-1 right-1 size-3 origin-top-right scale-100 rounded-tr-[16px] border-foreground/60 border-t-[1.5px] border-r-[1.5px] opacity-70 transition-[opacity,scale] duration-200 ease-out group-focus-within/expand-corner:scale-50 group-focus-within/expand-corner:opacity-0 group-hover/expand-corner:scale-50 group-hover/expand-corner:opacity-0"
        />
        <button
          type="button"
          data-ui="chat.composer.action.expand"
          onClick={() => (hasCustomHeight ? restoreDefaultHeight() : toggleExpanded(true))}
          aria-pressed={hasCustomHeight}
          aria-label={hasCustomHeight ? t('chat.input.collapse') : t('chat.input.expand')}
          className="-translate-y-2.5 pointer-events-none absolute top-1 right-1 flex size-5.5 translate-x-2.5 rotate-[-8deg] scale-80 items-center justify-center rounded-full bg-transparent text-muted-foreground opacity-0 shadow-none transition-[opacity,translate,scale,rotate,color,background-color] duration-300 ease-out hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:translate-y-0 focus-visible:rotate-0 focus-visible:scale-100 focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100 group-focus-within/expand-corner:pointer-events-auto group-focus-within/expand-corner:translate-x-0 group-focus-within/expand-corner:translate-y-0 group-focus-within/expand-corner:rotate-0 group-focus-within/expand-corner:scale-100 group-focus-within/expand-corner:bg-accent/80 group-focus-within/expand-corner:text-foreground group-focus-within/expand-corner:opacity-100 group-hover/expand-corner:pointer-events-auto group-hover/expand-corner:translate-x-0 group-hover/expand-corner:translate-y-0 group-hover/expand-corner:rotate-0 group-hover/expand-corner:scale-100 group-hover/expand-corner:bg-accent/80 group-hover/expand-corner:text-foreground group-hover/expand-corner:opacity-100">
          <ExpandIcon className="size-3 transition-[scale] duration-300 ease-out group-focus-within/expand-corner:scale-110 group-hover/expand-corner:scale-110" />
        </button>
      </div>
      {/* V2:2220 topContent 直接嵌（无包裹）。 */}
      {props.topContent}
      {/* V2:2221-2247 行容器（非 compact）+ 编辑区 frame。 */}
      <div className={props.leadingContent ? 'flex items-start' : 'contents'}>
        {props.leadingContent ? <div className="shrink-0 pt-1.5 pl-3.5">{props.leadingContent}</div> : null}
        <div
          ref={frameRef}
          data-ui="part:composer-input"
          data-composer-editor-frame=""
          className="min-w-0 flex-1 overflow-hidden transition-[height] ease-out"
          style={frameStyle}>
          {/* fork 缝：V2 此处为 TipTap 内核，叉内用 V2 自带的受控 textarea 回退实现
              （V2 ComposerSurface.tsx:252-327；TipTap 专有调用已删）。 */}
          <textarea
            ref={textareaRef}
            aria-label={props.placeholder}
            value={props.text}
            placeholder={props.placeholder}
            rows={1}
            spellCheck={props.enableSpellCheck}
            data-ui="part:composer-input-field"
            className="box-border block w-full min-w-0 flex-1 resize-none overflow-auto bg-transparent text-foreground outline-none"
            style={{
              ...editorContentStyle,
              fontSize: props.fontSize,
              lineHeight: 1.4
            }}
            onChange={(event) => {
              props.onTextChange(event.currentTarget.value)
              maybeOpenPhrasePanel(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
            }}
            onFocus={() => props.onFocus?.()}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              // fork 缝：V2 ComposerSurfaceRuntime.tsx:1503-1512 —— 提示框为空（trim 后）且挂了附件时，
              // Backspace 摘掉最后一个附件并吞掉删除（否则会冒泡成"返回上一页"之类的宿主行为）。
              // V2 另有"光标前无 token"这一条：fork 的 textarea 没有 token 内联件，text 空即等价成立。
              if (event.key === 'Backspace' && props.text.trim().length === 0 && props.filesCount > 0) {
                props.setFiles((prev) => prev.slice(0, -1))
                event.preventDefault()
                return
              }
              const isEnterPressed =
                (event.key === 'Enter' || event.key === 'NumpadEnter') && !event.nativeEvent.isComposing
              if (!isEnterPressed) return
              // Enter 发送 / Shift+Enter 换行（不拦截）；IME 组合中不发送。
              if (!isSendMessageKeyPressed(event, 'Enter')) return
              event.preventDefault()
              if (event.repeat) return
              if (props.sendDisabled) showBlockedSendReason()
              else void props.onSendDraft(getDraft())
            }}
          />
        </div>
      </div>
      {/* V2:2257-2268 底部 toolbar（非 compact 分支）。 */}
      <div
        data-ui="part:composer-actions"
        data-composer-toolbar=""
        className="relative z-2 flex h-10 shrink-0 flex-row justify-between gap-4 px-2 py-1.25">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">{leftControls}</div>
        <div className="flex flex-row items-center gap-1.5">
          {sendAccessoryElement}
          {sendAction}
        </div>
      </div>
    </div>
  )

  const inputbarStack = (
    <div className="relative">
      {quickPanelElement}
      {inputbarElement}
    </div>
  )

  // V2:2278-2320 NarrowLayout 外层（非 compact 分支；V2 的 `belowControls` 分支不适用）。
  // fork 缝：不用 fork 的 NarrowLayout 组件——它读**全局** narrowMode 设置、且不支持 V2 的
  // `withSidePadding`；这里按 V2 `NarrowLayout.tsx:13-19` 逐字拼 class，保持 V2 的
  // "居中 800px 上限 + 两侧 24px 内边距"（`railGutterPx` 分支在绘画不传，故走 withSidePadding）。
  const narrowLayoutClassName = [
    'narrow-mode relative mx-auto w-full transition-[max-width] duration-300 ease-in-out',
    props.narrowMode ? 'active' : 'max-w-full',
    props.narrowMode ? 'max-w-[calc(800px+3rem)]' : undefined,
    'box-border px-6',
    'pointer-events-auto'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={narrowLayoutClassName} style={{ width: '100%' }}>
      <div className="w-full">
        <div
          className="inputbar relative z-2 flex flex-col pt-0"
          onDragEnter={dragDrop.handleDragEnter}
          onDragLeave={dragDrop.handleDragLeave}
          onDragOver={dragDrop.handleDragOver}
          onDrop={dragDrop.handleDrop}>
          {props.queueContent}
          {inputbarStack}
        </div>
      </div>
    </div>
  )
}

export default ComposerSurface
