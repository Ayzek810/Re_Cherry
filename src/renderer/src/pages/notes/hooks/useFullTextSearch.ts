import type { SearchOptions, SearchResult } from '@renderer/services/NotesSearchService'
import { searchAllFiles } from '@renderer/services/NotesSearchService'
import type { NotesTreeNode } from '@renderer/types/note'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseFullTextSearchOptions extends SearchOptions {
  debounceMs?: number
  maxResults?: number
  enabled?: boolean
}

export interface UseFullTextSearchReturn {
  search: (nodes: NotesTreeNode[], keyword: string) => void
  cancel: () => void
  reset: () => void
  isSearching: boolean
  results: SearchResult[]
  stats: {
    total: number
    fileNameMatches: number
    contentMatches: number
    bothMatches: number
  }
  error: Error | null
  /**
   * 逐文件失败数（`searchAllFiles` 的 failures 汇总，r2-05 起服务层显式给出）。
   *
   * 全库检索的"部分失败"必须可见：整棵树读失败时结果集是空的，若只有 `error` 一个信号，
   * 用户看到的就是"搜到 0 条"（§9 failure must never look like an empty result）。
   */
  failedFiles: number
  /** 第一条失败的原因，供状态条的 `title` 展示（无失败时为 null）。 */
  failureMessage: string | null
  /**
   * 已产出 `results` / `stats` 的关键词（`null` = 尚无结果）。
   *
   * 消费方要靠它区分"这次关键词搜到了 0 条"与"这次关键词还没搜完"——`stats.total === 0`
   * 单独无法表达后者（防抖窗口内它仍是上一个关键词的值），二轮审查 f2-35 的
   * 空结果占位必须落在真答案上，不能落在旧答案上。
   */
  searchedKeyword: string | null
}

/**
 * Full-text search hook for notes
 */
export function useFullTextSearch(options: UseFullTextSearchOptions = {}): UseFullTextSearchReturn {
  const { debounceMs = 300, maxResults = 100, enabled = true, ...searchOptions } = options

  const [isSearching, setIsSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [searchedKeyword, setSearchedKeyword] = useState<string | null>(null)
  const [failedFiles, setFailedFiles] = useState(0)
  const [failureMessage, setFailureMessage] = useState<string | null>(null)
  const [stats, setStats] = useState({
    total: 0,
    fileNameMatches: 0,
    contentMatches: 0,
    bothMatches: 0
  })

  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Store options in refs to avoid reference changes
  const searchOptionsRef = useRef(searchOptions)
  const maxResultsRef = useRef(maxResults)
  const enabledRef = useRef(enabled)

  useEffect(() => {
    searchOptionsRef.current = searchOptions
    maxResultsRef.current = maxResults
    enabledRef.current = enabled
  }, [searchOptions, maxResults, enabled])

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    setIsSearching(false)
  }, [])

  const reset = useCallback(() => {
    cancel()
    setResults([])
    setStats({ total: 0, fileNameMatches: 0, contentMatches: 0, bothMatches: 0 })
    setError(null)
    setSearchedKeyword(null)
    setFailedFiles(0)
    setFailureMessage(null)
  }, [cancel])

  const performSearch = useCallback(
    async (nodes: NotesTreeNode[], keyword: string) => {
      if (!enabledRef.current) {
        return
      }

      cancel()

      if (!keyword) {
        setResults([])
        setStats({ total: 0, fileNameMatches: 0, contentMatches: 0, bothMatches: 0 })
        setSearchedKeyword(null)
        setFailedFiles(0)
        setFailureMessage(null)
        return
      }

      setIsSearching(true)
      setError(null)

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const { results: searchResults, failures } = await searchAllFiles(
          nodes,
          keyword.trim(),
          searchOptionsRef.current,
          abortController.signal
        )

        if (abortController.signal.aborted) {
          return
        }

        const limitedResults = searchResults.slice(0, maxResultsRef.current)

        const newStats = {
          total: limitedResults.length,
          fileNameMatches: limitedResults.filter((r) => r.matchType === 'filename').length,
          contentMatches: limitedResults.filter((r) => r.matchType === 'content').length,
          bothMatches: limitedResults.filter((r) => r.matchType === 'both').length
        }

        setResults(limitedResults)
        setStats(newStats)
        setFailedFiles(failures.length)
        setFailureMessage(failures[0]?.error.message ?? null)
        // 只有真正拿到答案（含 0 条）才认领关键词：空结果占位与结果数都挂在这个事实上。
        setSearchedKeyword(keyword.trim())
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setError(err)
          // 失败不得长得像"没有结果"：清掉旧答案，让消费方走错误态而不是空态。
          setResults([])
          setStats({ total: 0, fileNameMatches: 0, contentMatches: 0, bothMatches: 0 })
          setFailedFiles(0)
          setFailureMessage(null)
          setSearchedKeyword(null)
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsSearching(false)
        }
      }
    },
    [cancel]
  )

  const search = useCallback(
    (nodes: NotesTreeNode[], keyword: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(() => {
        void performSearch(nodes, keyword)
      }, debounceMs)
    },
    [performSearch, debounceMs]
  )

  useEffect(() => {
    return () => {
      cancel()
    }
  }, [cancel])

  return {
    search,
    cancel,
    reset,
    isSearching,
    results,
    stats,
    error,
    failedFiles,
    failureMessage,
    searchedKeyword
  }
}
