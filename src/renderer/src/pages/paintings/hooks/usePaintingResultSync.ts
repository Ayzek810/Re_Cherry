/**
 * 生成结果回灌 hook（v0.3.3 批次4，② 薄适配）：V2 DataApi 订阅 → 生成 promise
 * 回调（同进程 await 即回填，逻辑简化）。保留"只同步 files、只增不减、幂等"
 * 三条不变量——后台完成的生成经 PaintingSessionContext 镜像对账。
 */
import type { Dispatch, SetStateAction } from 'react'
import { useEffect } from 'react'

import { usePaintingSession } from '../context/PaintingSessionContext'
import type { PaintingData } from '../model/types/paintingData'

interface UsePaintingResultSyncInput {
  currentPainting: PaintingData
  historyItems: PaintingData[]
  setCurrentPainting: Dispatch<SetStateAction<PaintingData>>
}

/**
 * Backfill a completed generation's output files into the live `currentPainting`
 * when they only landed in refreshed history.
 *
 * A background generation finishes by calling `usePaintingGeneration`'s
 * `applyIfVisible` — a no-op when the finishing painting isn't the visible one at
 * completion time (the user switched away). In that case the in-memory draft keeps
 * `files: []` while the Dexie row — and therefore the refreshed history — gained
 * the outputs. The page does not automatically re-adopt history items, so the
 * visible in-memory painting needs this targeted result sync.
 *
 * The Artboard's reveal machine, having watched loading go false with no file,
 * then parks at `{ status: 'awaiting' }` forever. Copying the files in supplies
 * the `currentFile` the reveal is waiting for. Only `files` is synced — prompt,
 * params, inputFiles and every other local edit are preserved — and only when
 * history carries strictly more outputs than the local copy, so a fresh draft
 * (absent from history) and an in-flight generation (history not yet caught up)
 * are both left untouched and the sync is idempotent.
 */
export function usePaintingResultSync({ currentPainting, historyItems, setCurrentPainting }: UsePaintingResultSyncInput) {
  const { generationStateById } = usePaintingSession()
  const currentId = currentPainting.id
  const localFileCount = currentPainting.files.length
  const historyFiles = historyItems.find((item) => item.id === currentId)?.files
  // 同进程 await 即回填：会话镜像里该画已无在途态（null/absent）才允许对账。
  const sessionState = generationStateById.get(currentId) ?? null

  useEffect(() => {
    if (sessionState?.generationStatus === 'running') return
    if (!historyFiles || historyFiles.length <= localFileCount) return
    setCurrentPainting((prev) => {
      // Re-check against the freshest state: the visible generation's own
      // applyIfVisible may have merged these files between render and commit.
      if (prev.id !== currentId || prev.files.length >= historyFiles.length) return prev
      return { ...prev, files: historyFiles }
    })
  }, [currentId, localFileCount, historyFiles, sessionState, setCurrentPainting])
}
