/**
 * 绘画页会话上下文（v0.3.3 批次4，② 薄适配，V2 paintingGenerationParams 的
 * cache 投影改为 feature 内 React Context）：currentPainting 草稿 + patch/set
 * 动作 + 生成状态镜像（generatingById，瞬态不持久化——V2
 * cacheService.set(`painting.generation.${id}`) 的本地等价）。Provider 由页面挂。
 * v0.3.3-3：参考图托盘移出上下文——V2 的作曲条自持文件状态（fork 侧由作曲条内
 * usePaintingComposerInputFiles 实例承担），此处保留的旧托盘已无消费者。
 */
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import type { PaintingGenerationState } from '@renderer/pages/paintings/model/utils/paintingGenerationParams'
import type { Dispatch, SetStateAction } from 'react'
import React, { createContext, use, useCallback, useMemo, useState } from 'react'

export interface PaintingSessionValue {
  currentPainting: PaintingData
  patchPainting: (updates: Partial<PaintingData>) => void
  setCurrentPainting: Dispatch<SetStateAction<PaintingData>>
  /** 生成状态镜像（paintingId → running/failed/canceled + error；null = 清除）。 */
  generationStateById: Map<string, PaintingGenerationState | null>
  setGenerationState: (paintingId: string, state: PaintingGenerationState | null) => void
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

  // v0.3.3-3：参考图托盘（含 capability 推导）已移出上下文——V2 的作曲条自持文件状态，
  // fork 侧由作曲条内的 usePaintingComposerInputFiles 实例承担；上下文只留草稿与生成镜像。

  const value = useMemo<PaintingSessionValue>(
    () => ({ currentPainting, patchPainting, setCurrentPainting, generationStateById, setGenerationState }),
    [currentPainting, patchPainting, generationStateById, setGenerationState]
  )
  return <PaintingSessionContext value={value}>{children}</PaintingSessionContext>
}

export function usePaintingSession(): PaintingSessionValue {
  const ctx = use(PaintingSessionContext)
  if (!ctx) throw new Error('usePaintingSession must be used within a PaintingSessionProvider')
  return ctx
}
