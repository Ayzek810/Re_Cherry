/**
 * 绘画历史分页 hook（v0.3.3 批次4，V2 usePaintingHistory 重写）：
 * DataApi useInfiniteQuery → Dexie keyset 分页（orderBy('createdAt').reverse()
 * + where('createdAt').below(cursor)）；条目水合走 recordToPaintingData
 * （V2 recordsToPaintingDataList 语义，文件解析为 Dexie 内嵌直通）。
 */
import { db } from '@renderer/databases'
import { loggerService } from '@renderer/services/LoggerService'
import { recordsToPaintingDataList } from '@renderer/pages/paintings/model/recordToPaintingData'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { useCallback, useEffect, useRef, useState } from 'react'

const logger = loggerService.withContext('usePaintingHistory')

const PAGE_SIZE = 30

export type PaintingStripEntry = PaintingData

export function usePaintingHistory(): {
  items: PaintingStripEntry[]
  isLoading: boolean
  hasMore: boolean
  loadMore: () => void
  reload: () => void
} {
  const [items, setItems] = useState<PaintingStripEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasMore, setHasMore] = useState(true)
  // keyset 游标：已载入最旧一行的 createdAt（reverse 后页尾）。
  const cursorRef = useRef<number | undefined>(undefined)
  const loadingRef = useRef(false)

  const loadPage = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setIsLoading(true)
    try {
      let query = db.paintings.orderBy('createdAt').reverse()
      if (!reset && cursorRef.current !== undefined) {
        query = db.paintings.where('createdAt').below(cursorRef.current).reverse() as typeof query
      }
      const rows = await query.limit(PAGE_SIZE).toArray()
      const mapped = await recordsToPaintingDataList(rows)
      cursorRef.current = rows.length > 0 ? rows[rows.length - 1].createdAt : cursorRef.current
      setItems((prev) => (reset ? mapped : [...prev, ...mapped]))
      setHasMore(rows.length === PAGE_SIZE)
    } catch (error) {
      logger.error('Failed to load painting history', error as Error)
    } finally {
      loadingRef.current = false
      setIsLoading(false)
    }
  }, [])

  const loadMore = useCallback(() => {
    if (hasMore) void loadPage(false)
  }, [hasMore, loadPage])

  const reload = useCallback(() => {
    cursorRef.current = undefined
    void loadPage(true)
  }, [loadPage])

  useEffect(() => {
    void loadPage(true)
  }, [loadPage])

  return { items, isLoading, hasMore, loadMore, reload }
}
