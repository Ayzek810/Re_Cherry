/**
 * Dexie paintings 表 CRUD hook（v0.3.3 批次4，V2 usePaintings 重写）：
 * DataApi useQuery/useMutation → Dexie 直查；reorder 简化为 createdAt 排序
 * （Dexie 行无排序字段，历史条永远按时间倒序展示）。
 */
import { db } from '@renderer/databases'
import type { PaintingRecord } from '@renderer/types'
import { loggerService } from '@renderer/services/LoggerService'
import { useCallback, useEffect, useState } from 'react'

const logger = loggerService.withContext('usePaintings')

export function usePaintings() {
  const [records, setRecords] = useState<PaintingRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const rows = await db.paintings.orderBy('createdAt').reverse().toArray()
      setRecords(rows)
    } catch (error) {
      logger.warn('load paintings failed', error as Error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addPainting = useCallback(async (record: PaintingRecord): Promise<PaintingRecord> => {
    await db.paintings.put(record)
    return record
  }, [])

  const updatePainting = useCallback(async (id: string, updates: Partial<PaintingRecord>): Promise<void> => {
    await db.paintings.update(id, { ...updates, updatedAt: Date.now() })
  }, [])

  const deletePainting = useCallback(async (id: string): Promise<void> => {
    await db.paintings.delete(id)
  }, [])

  /** reorder 语义简化：Dexie 无排序字段，历史条一律 createdAt 倒序（no-op 占位）。 */
  const reorderPaintings = useCallback(async (): Promise<void> => {
    await refresh()
  }, [refresh])

  return {
    records,
    isLoading,
    refresh,
    addPainting,
    updatePainting,
    deletePainting,
    reorderPaintings
  }
}
