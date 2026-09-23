/**
 * 绘画页会话上下文（v0.3.3 批次4，② 薄适配，V2 paintingGenerationParams 的
 * cache 投影改为 feature 内 React Context）：currentPainting 草稿 + patch/set
 * 动作 + 参考图托盘状态 + 生成状态镜像（generatingById，瞬态不持久化——V2
 * cacheService.set(`painting.generation.${id}`) 的本地等价）。Provider 由页面挂。
 */
import { usePaintingComposerInputFiles, type InputCapability } from '@renderer/pages/paintings/hooks/usePaintingComposerInputFiles'
import { supportsPaintingEdit } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import type { PaintingGenerationState } from '@renderer/pages/paintings/model/utils/paintingGenerationParams'
import React, { createContext, Dispatch, SetStateAction, use, useCallback, useMemo, useState } from 'react'

export interface PaintingSessionValue {
  currentPainting: PaintingData
  patchPainting: (updates: Partial<PaintingData>) => void
  setCurrentPainting: Dispatch<SetStateAction<PaintingData>>
  /** 生成状态镜像（paintingId → running/failed/canceled + error；null = 清除）。 */
  generationStateById: Map<string, PaintingGenerationState | null>
  setGenerationState: (paintingId: string, state: PaintingGenerationState | null) => void
  /** 参考图托盘（页面自持 inputFiles 状态；SEED/MATERIALIZE/CLEAR 见 hook）。 */
  tray: ReturnType<typeof usePaintingComposerInputFiles>
}

const PaintingSessionContext = createContext<PaintingSessionValue | undefined>(undefined)

export function PaintingSessionProvider({
  children,
  initialPainting
}: {
  children: React.ReactNode
  initialPainting: PaintingData
}) {
  const [currentPainting, setCurrentPainting] = useState<PaintingData>(initialPainting)
  const [generationStateById, setGenerationStateById] = useState<Map<string, PaintingGenerationState | null>>(new Map())

  const patchPainting = useCallback((updates: Partial<PaintingData>) => {
    setCurrentPainting((current) => ({ ...current, ...updates }) as PaintingData)
  }, [])

  const setGenerationState = useCallback((paintingId: string, state: PaintingGenerationState | null) => {
    setGenerationStateById((prev) => {
      const next = new Map(prev)
      next.set(paintingId, state)
      return next
    })
  }, [])

  // 托盘 SEED 依赖 currentPainting.id / 存档输入 / provider；capability 按当前
  // 模型解析（supportsPaintingEdit）：'unknown' = 模型未选（不动托盘），
  // 'accept' = 图生图可用，'reject' = 纯生图（CLEAR 语义清托盘）。
  const providers = useAppSelector((state) => state.llm.providers)
  const inputCapability: InputCapability = useMemo(() => {
    if (!currentPainting.model) return 'unknown'
    const model = providers
      .find((provider) => provider.id === currentPainting.providerId)
      ?.models.find((candidate) => candidate.id === currentPainting.model)
    if (!model) return 'unknown'
    return supportsPaintingEdit(model) ? 'accept' : 'reject'
  }, [currentPainting.model, currentPainting.providerId, providers])

  const tray = usePaintingComposerInputFiles({
    paintingId: currentPainting.id,
    archivedInputFiles: currentPainting.inputFiles ?? [],
    inputCapability,
    providerId: currentPainting.providerId
  })

  const value = useMemo<PaintingSessionValue>(
    () => ({ currentPainting, patchPainting, setCurrentPainting, generationStateById, setGenerationState, tray }),
    [currentPainting, patchPainting, generationStateById, setGenerationState, tray]
  )
  return <PaintingSessionContext value={value}>{children}</PaintingSessionContext>
}

export function usePaintingSession(): PaintingSessionValue {
  const ctx = use(PaintingSessionContext)
  if (!ctx) throw new Error('usePaintingSession must be used within a PaintingSessionProvider')
  return ctx
}
