/**
 * 初始草稿对齐 hook（v0.3.3 批次4，② 薄适配）：V2 usePreference 两键
 * （painting.defaultProvider / painting.defaultModel）→ fork settings slice
 * （useAppSelector s.settings）；fork 无对应字段，用默认值常量（不改 settings
 * slice 结构）。isUntouchedDraft 判定原样。
 */
import { useAppSelector } from '@renderer/store'
import { useEffect, useRef } from 'react'

import { createDefaultPainting, type PaintingDraftDefaults } from '../model/paintingPipeline'
import type { PaintingData } from '../model/types/paintingData'

interface UsePaintingInitialDraftInput {
  currentPainting: PaintingData
  draftDefaults: PaintingDraftDefaults
  setCurrentPainting: (painting: PaintingData) => void
}

function isUntouchedDraft(painting: PaintingData) {
  return (
    !painting.persistedAt &&
    !painting.model &&
    !painting.prompt &&
    painting.files.length === 0 &&
    (painting.inputFiles?.length ?? 0) === 0 &&
    Object.keys(painting.params ?? {}).length === 0 &&
    !painting.generationStatus
  )
}

/**
 * Keep the page's initial empty draft aligned with the resolved draft defaults.
 *
 * The mount-time draft pins the fallback provider because `providerOptions` is
 * still `[]` then. Re-seed it as soon as those options resolve, unless the user
 * has already edited or replaced the draft.
 */
export function usePaintingInitialDraft({
  currentPainting,
  draftDefaults,
  setCurrentPainting
}: UsePaintingInitialDraftInput): void {
  // fork settings slice 无 painting 默认 provider/model 字段——用空默认值常量
  // （'' = 无偏好，跟随 providerOptions 首项），不改 settings slice 结构。
  const preferredProviderId = useAppSelector(() => '') as string
  const preferredModelId = useAppSelector(() => '') as string
  const bootstrapDraftIdRef = useRef(currentPainting.id)

  useEffect(() => {
    if (currentPainting.id !== bootstrapDraftIdRef.current) return
    if (currentPainting.persistedAt || !isUntouchedDraft(currentPainting)) return

    const resolvedDefaults: PaintingDraftDefaults = {
      providerId: preferredProviderId || draftDefaults.providerId,
      ...(preferredModelId ? { modelId: preferredModelId } : draftDefaults.modelId ? { modelId: draftDefaults.modelId } : {})
    }

    if (
      resolvedDefaults.providerId &&
      (currentPainting.providerId !== resolvedDefaults.providerId ||
        currentPainting.model !== resolvedDefaults.modelId)
    ) {
      const nextPainting = createDefaultPainting(resolvedDefaults)
      bootstrapDraftIdRef.current = nextPainting.id
      setCurrentPainting(nextPainting)
    }
  }, [currentPainting, draftDefaults, preferredModelId, preferredProviderId, setCurrentPainting])
}
