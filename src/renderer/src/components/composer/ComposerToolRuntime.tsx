// fork 缝：V2 `components/composer/ComposerToolRuntime.tsx` 的 8 个导出替身。
// V2 该文件是工具注册表 + TipTap 面板 + 编辑器 token 对账；fork 无工具注册表，
// 绘画只用其中的 provider 状态（files / isExpanded / mentionedModels /
// selectedKnowledgeBases / toolsRegistry）与 launcher 三件套。此处只实现
// PaintingComposer 实际消费的符号，launcher 面恒空（无工具即无启动器）。
import type { ComposerAttachment } from '@renderer/components/composer/variants/shared/composerTokens'
import type { Model } from '@renderer/types'
import React, { createContext, use, useCallback, useMemo, useState } from 'react'

import type { ComposerToolLauncher } from './quickPanel'
import type { ComposerSerializedToken } from './tokens'

/** fork 缝：V2 `tools/types.ts:15` 的 scope；fork 只需 painting。 */
export type ComposerToolScope = 'painting'

interface ComposerToolActions {
  addNewTopic: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
}

export interface ComposerToolState {
  files: ComposerAttachment[]
  mentionedModels: Model[]
  selectedKnowledgeBases: unknown[]
  isExpanded: boolean
}

export interface ComposerToolDispatch {
  setFiles: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>
  setIsExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setMentionedModels: React.Dispatch<React.SetStateAction<Model[]>>
  setSelectedKnowledgeBases: React.Dispatch<React.SetStateAction<unknown[]>>
  toolsRegistry: { registerLaunchers: (entries: ComposerToolLauncher[]) => () => void }
}

interface ComposerToolContextValue extends ComposerToolState, ComposerToolDispatch {
  addNewTopic: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
}

interface ComposerToolRuntimeProviderProps {
  children: React.ReactNode
  initialState?: Partial<{
    files: ComposerAttachment[]
    isExpanded: boolean
    couldAddImageFile: boolean
    extensions: string[]
  }>
  actions: ComposerToolActions
}

interface ComposerToolRuntimeBootstrapProps {
  scope: ComposerToolScope
  model: Model
}

const ComposerToolContext = createContext<ComposerToolContextValue | undefined>(undefined)

const useComposerToolProvider = () => {
  const context = use(ComposerToolContext)
  if (!context) throw new Error('ComposerToolRuntimeProvider is required')
  return context
}

/** V2 `ComposerToolRuntime.tsx:53-59` `ComposerToolRuntimeProvider`（初始态 + actions）。 */
export const ComposerToolRuntimeProvider = ({ children, initialState, actions }: ComposerToolRuntimeProviderProps) => {
  const [files, setFiles] = useState<ComposerAttachment[]>(initialState?.files ?? [])
  const [isExpanded, setIsExpanded] = useState(initialState?.isExpanded ?? false)
  const [mentionedModels, setMentionedModels] = useState<Model[]>([])
  const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState<unknown[]>([])

  const registerLaunchers = useCallback(() => () => undefined, [])
  const toolsRegistry = useMemo(() => ({ registerLaunchers }), [registerLaunchers])

  const value = useMemo<ComposerToolContextValue>(
    () => ({
      files,
      isExpanded,
      mentionedModels,
      selectedKnowledgeBases,
      setFiles,
      setIsExpanded,
      setMentionedModels,
      setSelectedKnowledgeBases,
      toolsRegistry,
      addNewTopic: actions.addNewTopic,
      onTextChange: actions.onTextChange
    }),
    [
      actions.addNewTopic,
      actions.onTextChange,
      files,
      isExpanded,
      mentionedModels,
      selectedKnowledgeBases,
      toolsRegistry
    ]
  )

  return <ComposerToolContext value={value}>{children}</ComposerToolContext>
}

/** V2 `ComposerToolRuntime.tsx:205-206`：provider 状态/派发的公开别名。 */
export const useComposerToolState = (): ComposerToolState => useComposerToolProvider()
export const useComposerToolDispatch = (): ComposerToolDispatch => useComposerToolProvider()

/** V2 `ComposerToolRuntime.tsx:147-203` `ComposerToolRuntimeHost`：无工具即无宿主内容。 */
export const ComposerToolRuntimeHost = (_props: ComposerToolRuntimeBootstrapProps) => null

/** V2 `ComposerToolRuntime.tsx:207` `ComposerToolDerivedStateProvider`：fork 无派生态。 */
export const ComposerToolDerivedStateProvider = ({
  children
}: {
  children: React.ReactNode
  /** V2 传 `couldAddImageFile`/`extensions`（工具可见性派生）；fork 无工具，接受并忽略。 */
  couldAddImageFile?: boolean
  extensions?: string[]
}) => children

/**
 * V2 `ComposerToolRuntime.tsx:261-279` `useComposerTokenReconcile`：V2 把编辑器 token
 * 变化对账回 provider 状态。fork 缝的 textarea 不产生 token 编辑事件，绘画也把
 * `files` 当唯一真相（V2 注释同此），故对账为空实现，只保留回调形状。
 */
export function useComposerTokenReconcile(_inputs: { scope: ComposerToolScope; model?: Model }) {
  return useCallback((_draftTokens: readonly ComposerSerializedToken[]) => undefined, [])
}

/** V2 `ComposerToolRuntime.tsx:334-347` `useComposerToolLauncherActions`（无工具 ⇒ 空）。 */
export function useComposerToolLauncherActions() {
  const getLaunchers = useCallback((_source?: string): ComposerToolLauncher[] => [], [])
  const dispatchLauncher = useCallback(
    (_launcher: ComposerToolLauncher, _options: { source: 'popover' | 'root-panel'; searchText?: string }) =>
      undefined,
    []
  )
  return { getLaunchers, dispatchLauncher }
}

/** V2 `ComposerToolRuntime.tsx:349-351` `useComposerToolLauncherVersion`（无工具 ⇒ 恒 0）。 */
export function useComposerToolLauncherVersion() {
  return 0
}
