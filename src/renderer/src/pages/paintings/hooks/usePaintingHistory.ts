/**
 * 绘画历史分页 hook（V2 usePaintingHistory 重写）：
 * DataApi useInfiniteQuery → Dexie keyset 分页（orderBy('createdAt').reverse()
 * + where('createdAt').below(cursor)）；条目水合走 recordToPaintingData
 * （V2 recordsToPaintingDataList 语义，文件解析为 Dexie 内嵌直通）。
 *
 * 失败语义：读失败**不得**与"没有历史"同形，也不得让 `hasMore` 停在 true。
 * 失败时 `hasMore` 置 false（否则缩略条的 `{hasMore && <Loader2/>}` 永远转圈）、`error` 置位，
 * 由 `PaintingStrip` 渲染可重试的错误态；`retry()` 清错后重跑首页。
 */
import { db } from '@renderer/databases'
import { recordsToPaintingDataList } from '@renderer/pages/paintings/model/recordToPaintingData'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { loggerService } from '@renderer/services/LoggerService'
import { useCallback, useEffect, useRef, useState } from 'react'

const logger = loggerService.withContext('usePaintingHistory')

const PAGE_SIZE = 30

export type PaintingStripEntry = PaintingData

export interface PaintingHistoryResult {
  items: PaintingStripEntry[]
  isLoading: boolean
  hasMore: boolean
  /** 首页/续页读取失败的原因；null = 没有失败。 */
  error: Error | null
  loadMore: () => void
  reload: () => void
  /** 清掉错误态并重跑首页（错误态里的"重试"）。 */
  retry: () => void
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function usePaintingHistory(): PaintingHistoryResult {
  const [items, setItems] = useState<PaintingStripEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  // keyset 游标：已载入最旧一行的 createdAt（reverse 后页尾）。
  const cursorRef = useRef<number | undefined>(undefined)
  const loadingRef = useRef(false)
  // `reload()` 的调用点全是"写后刷新"（生成成功落盘、删除画作），而它此前在
  // 分页在途时被直接丢弃——用户滚动加载下一页（或条未满自动补页）期间生成完成，落盘的新画作
  // 不会出现在缩略条里，用户以为生成丢了。改为"待处理标志"：在途时记账，`finally` 里补跑一次首页。
  const pendingReloadRef = useRef(false)
  // 卸载守卫：Dexie 查询在页面切走后回包时不再写状态。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadPage = useCallback(async (reset: boolean) => {
    if (loadingRef.current) {
      // 只有"写后刷新"能在在途时记账；补页（loadMore）本身已有 hasMore 闸，不重复排队。
      if (reset) pendingReloadRef.current = true
      return
    }
    pendingReloadRef.current = false
    loadingRef.current = true
    setIsLoading(true)
    try {
      let query = db.paintings.orderBy('createdAt').reverse()
      if (!reset && cursorRef.current !== undefined) {
        query = db.paintings.where('createdAt').below(cursorRef.current).reverse()
      }
      const rows = await query.limit(PAGE_SIZE).toArray()
      if (!mountedRef.current) return
      // recordsToPaintingDataList 是同步纯函数（Dexie 内嵌直通），不得 await
      const mapped = recordsToPaintingDataList(rows)
      cursorRef.current = rows.length > 0 ? rows[rows.length - 1].createdAt : cursorRef.current
      setItems((prev) => (reset ? mapped : [...prev, ...mapped]))
      setHasMore(rows.length === PAGE_SIZE)
      setError(null)
    } catch (caught) {
      const failure = toError(caught)
      logger.error('Failed to load painting history', failure)
      if (!mountedRef.current) return
      // 失败不得伪装成"没有历史"：置错误态，并停掉分页转圈（否则缩略条永久 spinner）。
      setError(failure)
      setHasMore(false)
    } finally {
      loadingRef.current = false
      if (mountedRef.current) setIsLoading(false)
      // 在途期间被丢弃的"写后刷新"在这里补跑，新落盘/新删除的画作才会立刻反映到缩略条。
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false
        void loadPage(true)
      }
    }
  }, [])

  const loadMore = useCallback(() => {
    if (hasMore) void loadPage(false)
  }, [hasMore, loadPage])

  const reload = useCallback(() => {
    cursorRef.current = undefined
    void loadPage(true)
  }, [loadPage])

  const retry = useCallback(() => {
    setError(null)
    cursorRef.current = undefined
    void loadPage(true)
  }, [loadPage])

  useEffect(() => {
    void loadPage(true)
  }, [loadPage])

  return { items, isLoading, hasMore, error, loadMore, reload, retry }
}
