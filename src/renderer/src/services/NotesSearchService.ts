import { loggerService } from '@logger'
import type { NotesTreeNode } from '@renderer/types/note'
import { escapeRegex } from '@renderer/utils/keywordSearch'

const logger = loggerService.withContext('NotesSearchService')

/**
 * Search match result
 */
export interface SearchMatch {
  lineNumber: number
  lineContent: string
  matchStart: number
  matchEnd: number
  context: string
}

/**
 * Search result with match information
 */
export interface SearchResult extends NotesTreeNode {
  matchType: 'filename' | 'content' | 'both'
  matches?: SearchMatch[]
  score: number
}

/**
 * Search options
 */
export interface SearchOptions {
  caseSensitive?: boolean
  useRegex?: boolean
  maxFileSize?: number
  maxMatchesPerFile?: number
  contextLength?: number
}

/**
 * Calculate relevance score
 * - Filename match has higher priority
 * - More matches increase score
 * - More recent updates increase score
 */
export function calculateRelevanceScore(node: NotesTreeNode, keyword: string, matches: SearchMatch[]): number {
  let score = 0

  // Exact filename match (highest weight)
  if (node.name.toLowerCase() === keyword.toLowerCase()) {
    score += 200
  }
  // Filename contains match (high weight)
  else if (node.name.toLowerCase().includes(keyword.toLowerCase())) {
    score += 100
  }

  // Content match count
  score += Math.min(matches.length * 2, 50)

  // Recent updates boost score
  const daysSinceUpdate = (Date.now() - new Date(node.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
  score += Math.max(0, 10 - daysSinceUpdate)

  return score
}

/**
 * 单文件检索结果（判别式，失败与「零命中」必须可分）
 * - `matched`：命中；
 * - `no-match`：文件读到了、内容也扫了，就是没有匹配（正常的零命中）；
 * - `error`：读文件 / 构造正则失败 —— **不是**零命中（旧实现把两者都返回 `null`，
 *   调用方只能看到「无结果」，读失败被静默吞成空态）。
 */
export type SearchFileOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'no-match' }
  | { kind: 'error'; error: Error }

/** 全库检索结果：命中 + 逐文件失败清单（失败不得伪装成空结果）。 */
export interface SearchAllFilesOutcome {
  results: SearchResult[]
  /** 读取/扫描失败的文件（含原因），供调用方给出「N 个文件读取失败」的可见信号。 */
  failures: { node: NotesTreeNode; error: Error }[]
}

/**
 * Search file content for keyword matches
 */
export async function searchFileContent(
  node: NotesTreeNode,
  keyword: string,
  options: SearchOptions = {}
): Promise<SearchFileOutcome> {
  const {
    caseSensitive = false,
    useRegex = false,
    maxFileSize = 10 * 1024 * 1024, // 10MB
    maxMatchesPerFile = 50,
    contextLength = 50
  } = options

  try {
    if (node.type !== 'file') {
      return { kind: 'no-match' }
    }

    const content = await window.api.file.readExternal(node.externalPath)

    if (!content) {
      return { kind: 'no-match' }
    }

    if (content.length > maxFileSize) {
      // 策略性跳过（不是读失败）：文件读到了但超出检索体积上限，留 warn 取证。
      logger.warn(`File too large to search: ${node.externalPath} (${content.length} bytes)`)
      return { kind: 'no-match' }
    }

    const flags = caseSensitive ? 'g' : 'gi'
    const pattern = useRegex ? new RegExp(keyword, flags) : new RegExp(escapeRegex(keyword), flags)

    const lines = content.split('\n')
    const matches: SearchMatch[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      pattern.lastIndex = 0

      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        const matchStart = match.index
        const matchEnd = matchStart + match[0].length

        // Keep context short: only 2 chars before match, more after
        const beforeMatch = Math.min(2, matchStart)
        const contextStart = matchStart - beforeMatch
        const contextEnd = Math.min(line.length, matchEnd + contextLength)

        // Add ellipsis if context doesn't start at line beginning
        const prefix = contextStart > 0 ? '...' : ''
        const contextText = prefix + line.substring(contextStart, contextEnd)

        matches.push({
          lineNumber: i + 1,
          lineContent: line,
          matchStart: beforeMatch + prefix.length,
          matchEnd: matchEnd - matchStart + beforeMatch + prefix.length,
          context: contextText
        })

        if (matches.length >= maxMatchesPerFile) {
          break
        }
      }

      if (matches.length >= maxMatchesPerFile) {
        break
      }
    }

    if (matches.length === 0) {
      return { kind: 'no-match' }
    }

    const score = calculateRelevanceScore(node, keyword, matches)

    return {
      kind: 'matched',
      result: {
        ...node,
        matchType: 'content',
        matches,
        score
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    logger.error(`Failed to search file content for ${node.externalPath}:`, failure)
    // 失败以 `error` 判别返回，由 searchAllFiles 汇总进 failures；
    // 不再与「零命中」同值，调用方的 setError 因此可达。
    return { kind: 'error', error: failure }
  }
}

/**
 * Check if filename matches keyword
 */
export function matchFileName(node: NotesTreeNode, keyword: string, caseSensitive = false): boolean {
  const name = caseSensitive ? node.name : node.name.toLowerCase()
  const key = caseSensitive ? keyword : keyword.toLowerCase()
  return name.includes(key)
}

/**
 * Flatten tree to extract file nodes
 */
export function flattenTreeToFiles(nodes: NotesTreeNode[]): NotesTreeNode[] {
  const result: NotesTreeNode[] = []

  function traverse(nodes: NotesTreeNode[]) {
    for (const node of nodes) {
      if (node.type === 'file') {
        result.push(node)
      }
      if (node.children && node.children.length > 0) {
        traverse(node.children)
      }
    }
  }

  traverse(nodes)
  return result
}

/**
 * Search all files concurrently
 *
 * 返回值改为 `{ results, failures }` 汇总。此前失败与「零命中」同为 `null`，
 * 调用方（`useFullTextSearch`）的 `setError` 永不执行——读文件失败时全库检索静默显示「无结果」。
 * 现在逐文件失败被收集成显式清单，调用方可以给出「N 个文件读取失败」的信号。
 */
export async function searchAllFiles(
  nodes: NotesTreeNode[],
  keyword: string,
  options: SearchOptions = {},
  signal?: AbortSignal
): Promise<SearchAllFilesOutcome> {
  const startTime = performance.now()
  const CONCURRENCY = 5
  const results: SearchResult[] = []
  const failures: { node: NotesTreeNode; error: Error }[] = []

  const fileNodes = flattenTreeToFiles(nodes)

  logger.debug(
    `Starting full-text search: keyword="${keyword}", totalFiles=${fileNodes.length}, options=${JSON.stringify(options)}`
  )

  const queue = [...fileNodes]

  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.aborted) {
        break
      }

      const node = queue.shift()
      if (!node) break

      const nameMatch = matchFileName(node, keyword, options.caseSensitive)
      const outcome = await searchFileContent(node, keyword, options)

      if (outcome.kind === 'error') {
        failures.push({ node, error: outcome.error })
      }
      const contentResult = outcome.kind === 'matched' ? outcome.result : null

      if (nameMatch && contentResult) {
        results.push({
          ...contentResult,
          matchType: 'both',
          score: contentResult.score + 100
        })
      } else if (nameMatch) {
        results.push({
          ...node,
          matchType: 'filename',
          matches: [],
          score: 100
        })
      } else if (contentResult) {
        results.push(contentResult)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fileNodes.length) }, () => worker()))

  const sortedResults = results.sort((a, b) => b.score - a.score)

  const endTime = performance.now()
  const duration = (endTime - startTime).toFixed(2)

  logger.debug(
    `Full-text search completed: keyword="${keyword}", duration=${duration}ms, ` +
      `totalFiles=${fileNodes.length}, resultsFound=${sortedResults.length}, ` +
      `failedFiles=${failures.length}, ` +
      `filenameMatches=${sortedResults.filter((r) => r.matchType === 'filename').length}, ` +
      `contentMatches=${sortedResults.filter((r) => r.matchType === 'content').length}, ` +
      `bothMatches=${sortedResults.filter((r) => r.matchType === 'both').length}`
  )

  return { results: sortedResults, failures }
}
