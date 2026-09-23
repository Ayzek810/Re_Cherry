/**
 * 生成执行 hook（v0.3.3 批次4，② 薄适配）：V2 DataApi 建/改行 → db.paintings.put
 * (PaintingRecord)；cache 镜像 → PaintingSessionContext 瞬态 generatingById；
 * AbortController 进 hook state（requestId 取消走 lightLlm.lightImageAbort）。
 * 生成主链路 = paintingPipeline.paintingGenerate → runPainting 落盘。
 */
import { db } from '@renderer/databases'
import { usePaintingSession } from '@renderer/pages/paintings/context/PaintingSessionContext'
import { presentPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { paintingDataToRecord } from '@renderer/pages/paintings/model/mappers/paintingRecordMappers'
import { paintingGenerate } from '@renderer/pages/paintings/model/paintingPipeline'
import { runPainting } from '@renderer/pages/paintings/model/runPainting'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { lightImageAbort } from '@renderer/services/lightLlm'
import { useAppSelector } from '@renderer/store'
import type { Provider } from '@renderer/types'
import { useCallback, useEffect, useRef } from 'react'

function hasOutput(painting: PaintingData) {
  return (painting.files?.length ?? 0) > 0
}

interface UsePaintingGenerationInput {
  painting: PaintingData
  onPaintingChange: (painting: PaintingData) => void
}

export function usePaintingGeneration({ painting, onPaintingChange }: UsePaintingGenerationInput) {
  const providers = useAppSelector((state) => state.llm.providers)
  const { setGenerationState } = usePaintingSession()
  const visibleIdRef = useRef(painting.id)
  // AbortController 进 hook state：requestId 配对取消（lightImageAbort）。
  const abortStateRef = useRef<{ controller: AbortController; requestId: string } | null>(null)

  useEffect(() => {
    visibleIdRef.current = painting.id
  }, [painting.id])

  // No unmount-abort: the page-level session mirror (`generatingById`) lets a
  // navigated-away generation finish, and the spinner rehydrates when the user
  // returns. Explicit cancel still flows through `cancelGeneration`.

  const isGenerating = useCallback((p: Pick<PaintingData, 'generationStatus'>) => {
    return p.generationStatus === 'running'
  }, [])

  const applyIfVisible = useCallback(
    (next: PaintingData) => {
      if (visibleIdRef.current === next.id) {
        onPaintingChange(next)
      }
    },
    [onPaintingChange]
  )

  const generate = useCallback(
    async (inputFiles: PaintingData['inputFiles']) => {
      // The in-memory draft is the source of truth for this whole flow.
      // DB writes are bookkeeping for the frozen receipt (prompt + file ids);
      // they're not consulted again to rebuild the live painting.
      const base: PaintingData = { ...painting, inputFiles }
      const shouldCreate = hasOutput(base) || !base.persistedAt
      const targetPainting: PaintingData = shouldCreate
        ? { ...base, id: hasOutput(base) ? crypto.randomUUID() : base.id, files: hasOutput(base) ? [] : base.files }
        : { ...base }

      const provider: Provider | undefined = providers.find((p) => p.id === targetPainting.providerId)
      if (!provider) {
        presentPaintingGenerateError(new Error(`Provider not found: ${targetPainting.providerId}`))
        return
      }

      const generationState = { generationStatus: 'running' as const, generationError: null }
      const controller = new AbortController()
      const requestId = `painting-${targetPainting.id}`

      // Generation state (running/failed/canceled) is the page's in-memory state
      // plus a PaintingSessionContext mirror keyed by paintingId. The mirror
      // outlives this component's unmount, so navigating away and back
      // rehydrates the running spinner.
      const pushGenerationState = (updates: Partial<typeof generationState>) => {
        Object.assign(generationState, updates, { generationStatus: 'running' as const })
        setGenerationState(targetPainting.id, { ...generationState })
        applyIfVisible({ ...targetPainting, ...generationState } as PaintingData)
      }

      try {
        // V2 create/update DTO → db.paintings.put(PaintingRecord)。
        const record = paintingDataToRecord(targetPainting, shouldCreate ? undefined : { id: targetPainting.id, createdAt: targetPainting.persistedAt ?? Date.now() })
        await db.paintings.put(record)
        targetPainting.persistedAt = record.createdAt
      } catch (error) {
        presentPaintingGenerateError(error)
        return
      }

      visibleIdRef.current = targetPainting.id
      onPaintingChange({ ...targetPainting, ...generationState } as PaintingData)
      abortStateRef.current = { controller, requestId }
      pushGenerationState(generationState)

      try {
        const generatedFiles = await runPainting(() =>
          paintingGenerate({
            painting: targetPainting,
            provider,
            abortController: controller
          })
        )
        // 回填 Dexie 行（output/input 引用）。
        const existing = await db.paintings.get(targetPainting.id)
        if (existing) {
          await db.paintings.put({
            ...existing,
            output: generatedFiles,
            input: targetPainting.inputFiles ?? [],
            updatedAt: Date.now()
          })
        }
        setGenerationState(targetPainting.id, null)
        // Merge the freshly-generated output into the in-memory draft; do not
        // re-read from the DB record (which would drop params / mode again).
        applyIfVisible({ ...targetPainting, files: generatedFiles } as PaintingData)
      } catch (error) {
        const isCanceled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        const failedState = {
          ...generationState,
          generationStatus: (isCanceled ? 'canceled' : 'failed') as PaintingData['generationStatus'],
          generationError: isCanceled ? null : error instanceof Error ? error.message : String(error)
        }
        setGenerationState(targetPainting.id, failedState)
        applyIfVisible({ ...targetPainting, ...failedState } as PaintingData)
        if (!isCanceled) {
          presentPaintingGenerateError(error)
        }
      } finally {
        abortStateRef.current = null
      }
    },
    [applyIfVisible, onPaintingChange, painting, providers, setGenerationState]
  )

  const cancel = useCallback((_paintingId: string) => {
    const state = abortStateRef.current
    if (!state) return
    // requestId 取消走 lightLlm.lightImageAbort（主进程 AbortSignal 配对）。
    void lightImageAbort(state.requestId)
    state.controller.abort()
  }, [])

  return {
    generate,
    cancel,
    generating: isGenerating(painting)
  }
}
