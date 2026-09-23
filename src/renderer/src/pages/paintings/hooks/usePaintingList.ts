/**
 * 绘画列表写侧（v0.3.3 批次4，② 薄适配）：add/remove/select 保留；saveCurrent →
 * db.paintings.put（V2 DataApi updatePainting → Dexie 行）。V2 deletePainting →
 * db.paintings.delete + 引用文件 FileManager.deleteFile。
 */
import { loggerService } from '@logger'
import { db } from '@renderer/databases'
import { presentPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { paintingDataToRecord } from '@renderer/pages/paintings/model/mappers/paintingRecordMappers'
import { createDefaultPainting, type PaintingDraftDefaults } from '@renderer/pages/paintings/model/paintingPipeline'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import FileManager from '@renderer/services/FileManager'
import { useCallback, useRef } from 'react'

const logger = loggerService.withContext('paintings/usePaintingList')

interface UsePaintingListInput {
  painting: PaintingData
  setCurrentPainting: (painting: PaintingData) => void
  draftDefaults: PaintingDraftDefaults
  historyItems: PaintingData[]
  cancelGeneration: (paintingId: string) => void
  reloadHistory: () => void
}

/**
 * Owns the painting list-item write-side lifecycle: add / remove.
 *
 * - `add()` seeds a fresh in-memory draft from the configured defaults. It is NOT
 *   persisted — like the page's mount-time draft, it only reaches Dexie when
 *   the user generates (`usePaintingGeneration` creates the row for an unsaved
 *   draft). This keeps blank paintings from piling up in the strip on every click.
 * - `remove(painting)` cancels any in-flight generation, deletes attached files,
 *   removes the DB record, and (if the deleted item is the current one) selects
 *   the next available painting or falls back to a fresh draft via `add()`.
 */
export function usePaintingList({
  painting,
  setCurrentPainting,
  draftDefaults,
  historyItems,
  cancelGeneration,
  reloadHistory
}: UsePaintingListInput) {
  const historyItemsRef = useRef<PaintingData[]>([])
  const paintingRef = useRef(painting)
  historyItemsRef.current = historyItems
  paintingRef.current = painting

  const saveCurrent = useCallback(async () => {
    const current = paintingRef.current
    if (!current.persistedAt) {
      return true
    }

    try {
      const existing = await db.paintings.get(current.id)
      if (existing) {
        await db.paintings.put(paintingDataToRecord(current, { id: existing.id, createdAt: existing.createdAt }))
      }
      return true
    } catch (error) {
      presentPaintingGenerateError(error)
      return false
    }
  }, [])

  const select = useCallback(
    async (target: PaintingData) => {
      const current = paintingRef.current
      if (target.id === current.id) return
      if (!(await saveCurrent())) return
      setCurrentPainting(target)
    },
    [saveCurrent, setCurrentPainting]
  )

  const add = useCallback(() => {
    setCurrentPainting(createDefaultPainting(draftDefaults))
  }, [draftDefaults, setCurrentPainting])

  const selectNextAfterDelete = useCallback(
    async (deletedId: string) => {
      const currentItems = historyItemsRef.current
      const deletedIndex = currentItems.findIndex((item) => item.id === deletedId)
      const nextPainting =
        deletedIndex >= 0
          ? (currentItems[deletedIndex + 1] ?? currentItems[deletedIndex - 1])
          : currentItems.find((item) => item.id !== deletedId)

      reloadHistory()

      if (nextPainting) {
        setCurrentPainting(nextPainting)
        return
      }
      add()
    },
    [add, reloadHistory, setCurrentPainting]
  )

  const remove = useCallback(
    async (target: PaintingData) => {
      cancelGeneration(target.id)
      try {
        // 引用文件清仓（V2 deletePainting 级联语义；FileManager.deleteFile 自带计数）。
        const files = [...(target.files ?? []), ...(target.inputFiles ?? [])]
        await db.paintings.delete(target.id)
        await FileManager.deleteFiles(files)
      } catch (error) {
        // A rejected DELETE (SQLITE_BUSY / Dexie) must surface like the
        // sibling write paths — otherwise the row silently reappears on the
        // next refresh with no toast or log.
        logger.error('Failed to delete painting', error as Error)
        presentPaintingGenerateError(error)
        return
      }
      if (target.id === painting.id) {
        await selectNextAfterDelete(target.id)
      } else {
        reloadHistory()
      }
    },
    [cancelGeneration, painting.id, reloadHistory, selectNextAfterDelete]
  )

  return { add, remove, select, saveCurrent }
}
