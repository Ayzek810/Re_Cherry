/**
 * 生成状态投影（v0.3.3 批次4，② 薄适配）：V2 的 cache 投影改为 feature 内
 * React Context（PaintingSessionContext）——PaintingGenerationState 收窄为
 * generationStatus/generationError（fork 无 job 机制，无 taskId/progress）。
 * 状态镜像存 PaintingSessionContext.generatingById（瞬态，不持久化）。
 */
import type { PaintingData, PaintingGenerationStatus } from '../types/paintingData'

export type PaintingGenerationState = Pick<PaintingData, 'generationStatus' | 'generationError'>

/** 空态（无在途 run）。 */
export function emptyPaintingGenerationState(): PaintingGenerationState {
  return { generationStatus: null, generationError: null }
}

/**
 * Project a terminal state onto the painting view. Returns `null` for the
 * absent / completed state so the context value `null` represents
 * "no in-flight or just-finished run" (V2 cacheValue null 语义).
 */
export function paintingGenerationStateToSession(state: PaintingGenerationState): PaintingGenerationState | null {
  if (!state.generationStatus) return null
  return { generationStatus: state.generationStatus, generationError: state.generationError ?? null }
}

/** Inverse of `paintingGenerationStateToSession` for hydrating the painting view. */
export function sessionToPaintingGenerationState(
  session: PaintingGenerationState | null
): PaintingGenerationState {
  if (!session) return emptyPaintingGenerationState()
  return { generationStatus: session.generationStatus, generationError: session.generationError }
}

export type { PaintingGenerationStatus }
