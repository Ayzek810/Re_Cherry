/**
 * 提交编排 hook（v0.3.3 批次4，② 薄适配）：validate→materialize→generate 骨架
 * 保留；materialize 桥简化——输入图来自页面自持 inputFiles（tray.materializeInputs），
 * 无 ComposerToolRuntime。两道闸（validateBeforeGenerate / complete flag）原样。
 */
import { useCallback, useRef, useState } from 'react'

import type { PaintingData } from '../model/types/paintingData'
import { presentPaintingGenerationGuardFeedback } from '../utils/presentPaintingGenerationGuardFeedback'
import { usePaintingGeneration } from './usePaintingGeneration'
import { usePaintingGenerationGuard } from './usePaintingGenerationGuard'

/** Resolves the composer's draft attachments into the files a request consumes. */
export type MaterializeInputs = () => Promise<{ files: PaintingData['inputFiles']; complete: boolean }>

interface UsePaintingGenerationSubmitInput {
  painting: PaintingData
  onPaintingChange: (painting: PaintingData) => void
}

/**
 * Single owner of the painting generation request: `validate -> materialize ->
 * generate`, plus the re-entrancy guard, cancel, and the state the UI reads.
 *
 * Two gates, deliberately at different points:
 * - `validateBeforeGenerate` asks whether a request is possible at all
 *   (provider enabled, model present and resolvable). Cheap and side-effect free,
 *   so it runs before anything is created.
 * - the `complete` flag asks whether the request's inputs fully resolved. It can
 *   only be answered after materialization, and aborts before the paid call.
 *
 * State: `submitting` is this hook's own — one user-initiated request in flight.
 * `generating` is *not*; it is derived from `painting.generationStatus` and can be
 * set by a run this component never started (a resumed generation rehydrates it
 * from the session mirror). Both compose into the guard, and both are forwarded
 * so the UI can disable a send without owning either.
 *
 * `cancel(paintingId)` keeps the original signature so list-side flows
 * (e.g. cancel-before-delete) can target a specific painting.
 */
export function usePaintingGenerationSubmit({ painting, onPaintingChange }: UsePaintingGenerationSubmitInput) {
  const { validateBeforeGenerate } = usePaintingGenerationGuard({ painting })
  const { generate, cancel, generating } = usePaintingGeneration({
    painting,
    onPaintingChange
  })

  // Ref is the re-entrancy source of truth (it blocks a second call in the same
  // tick, before any state-driven disable has re-rendered); the state mirrors it
  // for the UI.
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = useCallback(
    async (materialize: MaterializeInputs) => {
      if (generating || submittingRef.current) return
      submittingRef.current = true
      setSubmitting(true)
      try {
        const guardResult = await validateBeforeGenerate()
        if (!guardResult.ok) {
          void presentPaintingGenerationGuardFeedback(guardResult.reason, guardResult.error, painting.providerId)
          return
        }
        const { files, complete } = await materialize()
        // An incomplete set must never reach generation — the composer has already
        // dropped the failed chip and told the user; generating anyway would spend
        // the request on a silently smaller input set.
        if (!complete) return
        await generate(files)
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [generate, generating, painting.providerId, validateBeforeGenerate]
  )

  return { generating, submitting, submit, cancel }
}
