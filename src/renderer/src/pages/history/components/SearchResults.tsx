import { loggerService } from '@logger'
import { LoadingIcon } from '@renderer/components/Icons'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import type { Topic } from '@renderer/types'
import { type Message } from '@renderer/types/newMessage'
import {
  buildKeywordRegexes,
  buildKeywordUnionRegex,
  type KeywordMatchMode,
  splitKeywordsToTerms
} from '@renderer/utils/keywordSearch'
import { retryKernelQuery } from '@renderer/utils/topicBranch'
import { Button, List, Segmented, Spin, Typography } from 'antd'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('SearchResults')

const { Text, Title } = Typography

type SearchResult = {
  message: Message
  topic: Topic
  content: string
  snippet: string
}

/** 内核原始命中：摘要按匹配模式在客户端现算，故原始文本要留在 state 里。 */
type KernelHitResult = Omit<SearchResult, 'snippet'>

interface Props extends React.HTMLAttributes<HTMLDivElement> {
  keywords: string
  /** 面板是否可见。隐藏只影响展示，**不**影响检索入参（f2-60）。 */
  visible?: boolean
  onMessageClick: (message: Message) => void
  onTopicClick: (topic: Topic) => void
}

const SEARCH_SNIPPET_CONTEXT_LINES = 1
const SEARCH_SNIPPET_MAX_LINES = 12
const SEARCH_SNIPPET_MAX_LINE_LENGTH = 160
const SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS = 40
const SEARCH_SNIPPET_MAX_LINE_FRAGMENTS = 3

type ResultSortOrder = 'newest' | 'oldest'

const stripMarkdownFormatting = (text: string) => {
  return text
    .replace(/```(?:[^\n]*\n)?([\s\S]*?)```/g, '$1')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/<[^>]*>/g, '')
}

const normalizeText = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const mergeRanges = (ranges: Array<[number, number]>) => {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (!last || range[0] > last[1] + 1) {
      merged.push([range[0], range[1]])
      continue
    }
    last[1] = Math.max(last[1], range[1])
  }
  return merged
}

const buildLineSnippet = (line: string, regexes: RegExp[]) => {
  if (line.length <= SEARCH_SNIPPET_MAX_LINE_LENGTH) {
    return line
  }

  const matchRanges: Array<[number, number]> = []
  for (const regex of regexes) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(line)) !== null) {
      matchRanges.push([match.index, match.index + match[0].length])
      if (match[0].length === 0) {
        regex.lastIndex += 1
      }
    }
  }

  if (matchRanges.length === 0) {
    return `${line.slice(0, SEARCH_SNIPPET_MAX_LINE_LENGTH)}...`
  }

  const expandedRanges: Array<[number, number]> = matchRanges.map(([start, end]) => [
    Math.max(0, start - SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS),
    Math.min(line.length, end + SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS)
  ])
  const mergedRanges = mergeRanges(expandedRanges)
  const limitedRanges = mergedRanges.slice(0, SEARCH_SNIPPET_MAX_LINE_FRAGMENTS)

  let result = limitedRanges.map(([start, end]) => line.slice(start, end)).join(' ... ')
  // 片段未从行首开始，补前置省略号。
  if (limitedRanges[0][0] > 0) {
    result = `...${result}`
  }
  // 片段未覆盖到行尾，补后置省略号。
  if (limitedRanges[limitedRanges.length - 1][1] < line.length) {
    result = `${result}...`
  }
  // 还有未展示的匹配片段，提示省略。
  if (mergedRanges.length > SEARCH_SNIPPET_MAX_LINE_FRAGMENTS) {
    result = `${result}...`
  }
  // 最终长度超限，强制截断并补省略号。
  if (result.length > SEARCH_SNIPPET_MAX_LINE_LENGTH) {
    result = `${result.slice(0, SEARCH_SNIPPET_MAX_LINE_LENGTH)}...`
  }
  return result
}

const buildSearchSnippet = (text: string, terms: string[], matchMode: KeywordMatchMode) => {
  const normalized = normalizeText(stripMarkdownFormatting(text))
  const lines = normalized.split('\n')
  if (lines.length === 0) {
    return ''
  }

  const nonEmptyTerms = terms.filter((term) => term.length > 0)
  const regexes = buildKeywordRegexes(nonEmptyTerms, { matchMode, flags: 'gi' })
  const matchedLineIndexes: number[] = []

  if (regexes.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const isMatch = regexes.some((regex) => {
        regex.lastIndex = 0
        return regex.test(line)
      })
      if (isMatch) {
        matchedLineIndexes.push(i)
      }
    }
  }

  const ranges: Array<[number, number]> =
    matchedLineIndexes.length > 0
      ? mergeRanges(
          matchedLineIndexes.map((index) => [
            Math.max(0, index - SEARCH_SNIPPET_CONTEXT_LINES),
            Math.min(lines.length - 1, index + SEARCH_SNIPPET_CONTEXT_LINES)
          ])
        )
      : [[0, Math.min(lines.length - 1, SEARCH_SNIPPET_MAX_LINES - 1)]]

  const outputLines: string[] = []
  let truncated = false

  if (ranges[0][0] > 0) {
    outputLines.push('...')
  }

  for (const [start, end] of ranges) {
    if (outputLines.length >= SEARCH_SNIPPET_MAX_LINES) {
      truncated = true
      break
    }
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '...') {
      outputLines.push('...')
    }
    for (let i = start; i <= end; i += 1) {
      if (outputLines.length >= SEARCH_SNIPPET_MAX_LINES) {
        truncated = true
        break
      }
      outputLines.push(buildLineSnippet(lines[i], regexes))
    }
    if (truncated) {
      break
    }
  }

  if ((truncated || ranges[ranges.length - 1][1] < lines.length - 1) && outputLines.at(-1) !== '...') {
    outputLines.push('...')
  }

  return outputLines.join('\n')
}

const SearchResults: FC<Props> = ({ keywords, visible = true, onMessageClick, onTopicClick, ...props }) => {
  const { t } = useTranslation()
  const { handleScroll, containerRef } = useScrollPosition('SearchResults')
  const observerRef = useRef<MutationObserver | null>(null)

  const [matchMode, setMatchMode] = useState<KeywordMatchMode>('whole-word')
  const [sortOrder, setSortOrder] = useState<ResultSortOrder>('newest')
  const [searchTerms, setSearchTerms] = useState<string[]>(splitKeywordsToTerms(keywords))

  const [rawResults, setRawResults] = useState<KernelHitResult[]>([])
  const [searchStats, setSearchStats] = useState({ count: 0, time: 0 })
  const [isLoading, setIsLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 乱序守卫：只接受最后一次请求的结果（上一次检索若后到，不得覆盖新结果）。
  const requestIdRef = useRef(0)

  // 检索入参签名：`t(k)` 返回值可能每次渲染都是新数组，直接当依赖会让 effect 每渲染重跑。
  const searchTermsKey = searchTerms.join('\u0000')

  const onSearch = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setRawResults([])
    setIsLoading(true)
    setSearchError(null)

    if (keywords.length === 0) {
      if (requestId === requestIdRef.current) {
        setSearchStats({ count: 0, time: 0 })
        setSearchTerms([])
        setRawResults([])
        setIsLoading(false)
      }
      return
    }

    const startTime = performance.now()
    const newSearchTerms = splitKeywordsToTerms(keywords)

    try {
      // 内核查询三值契约（CLAUDE.md §6.5）：handler 要等 initTopics 之后才注册，启动窗口内的
      // "No handler registered" 是预期内的瞬时失败。`undefined` = 本次没问到（可重试）；
      // 任何其它值（含 hits 为空数组）都是确定性答案，立即返回；`null` = 全部尝试都没问到。
      const answer = await retryKernelQuery(async () => {
        try {
          return await window.api.dshSearchMessages(newSearchTerms)
        } catch (error) {
          logger.warn(
            '[SearchResults] kernel search did not answer',
            error instanceof Error ? error : new Error(String(error))
          )
          return undefined
        }
      })
      if (answer === null) {
        throw new Error('kernel search: no answer within the boot window')
      }
      if (requestId !== requestIdRef.current) return
      const { hits } = answer
      const results: KernelHitResult[] = hits.map((hit) => ({
        message: {
          id: `kernel-${hit.topicId}-${hit.seq}`,
          topicId: hit.topicId,
          role: hit.role,
          assistantId: 'kernel',
          createdAt: new Date(hit.createdAt).toISOString(),
          status: 'success',
          blocks: []
        } as Message,
        topic: { id: hit.topicId, name: hit.topicName } as Topic,
        content: hit.text
      }))

      const endTime = performance.now()
      setRawResults(results)
      setSearchStats({
        count: results.length,
        time: (endTime - startTime) / 1000
      })
      setSearchTerms(newSearchTerms)
    } catch (error) {
      // 失败不得伪装成"没有结果"，也不得把面板留在转圈 + 全透明的状态（二轮审查 f2-51）。
      logger.error('Failed to search kernel messages', error as Error)
      if (requestId !== requestIdRef.current) return
      setRawResults([])
      setSearchStats({ count: 0, time: 0 })
      setSearchError(error instanceof Error ? error.message : String(error))
      window.toast.error(t('history.search.failed'))
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false)
    }
    // `searchTermsKey` 是 `searchTerms` 的标量签名（join 结果）。它不参与函数体，但**必须**留在依赖里：
    // 检索入参 = `searchTerms`，没有这层签名遮掩，每次渲染的新数组引用都会让下面那个 `useEffect` 重跑
    // （= 每个无关渲染都重发一次内核检索）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywords, searchTermsKey, t])

  // 摘要/高亮只依赖匹配模式：切换"整词/包含"是纯本地重算，不再重发一次内核检索（f2-59）。
  const sortedSearchResults = useMemo(() => {
    const results: SearchResult[] = rawResults.map((hit) => ({
      ...hit,
      snippet: buildSearchSnippet(hit.content, searchTerms, matchMode)
    }))
    results.sort((a, b) => {
      const timeA = Date.parse(a.message.createdAt) || 0
      const timeB = Date.parse(b.message.createdAt) || 0
      if (timeA !== timeB) {
        return sortOrder === 'newest' ? timeB - timeA : timeA - timeB
      }
      return a.message.id.localeCompare(b.message.id)
    })
    return results
  }, [rawResults, searchTerms, matchMode, sortOrder])

  const highlightText = (text: string) => {
    // Escape HTML entities to prevent XSS from LLM response content
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const safeText = escapeHtml(text)
    const highlightRegex = buildKeywordUnionRegex(searchTerms, { matchMode, flags: 'gi' })
    if (!highlightRegex) {
      return <span dangerouslySetInnerHTML={{ __html: safeText }} />
    }
    const highlightedText = safeText.replace(highlightRegex, (match) => `<mark>${match}</mark>`)
    return <span dangerouslySetInnerHTML={{ __html: highlightedText }} />
  }

  useEffect(() => {
    void onSearch()
  }, [onSearch])

  useEffect(() => {
    if (!containerRef.current) return

    observerRef.current = new MutationObserver(() => {
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })

    observerRef.current.observe(containerRef.current, {
      childList: true,
      subtree: true
    })

    return () => observerRef.current?.disconnect()
  }, [containerRef])

  return (
    <Container ref={containerRef} {...props} onScroll={handleScroll}>
      <Spin spinning={isLoading} indicator={<LoadingIcon color="var(--color-text-2)" />}>
        <SearchToolbar>
          <Segmented
            shape="round"
            size="small"
            value={sortOrder}
            onChange={(value) => setSortOrder(value as ResultSortOrder)}
            options={[
              { label: t('history.search.sort.newest'), value: 'newest' },
              { label: t('history.search.sort.oldest'), value: 'oldest' }
            ]}
          />
          <Segmented
            shape="round"
            size="small"
            value={matchMode}
            onChange={(value) => setMatchMode(value as KeywordMatchMode)}
            options={[
              { label: t('history.search.match.whole_word'), value: 'whole-word' },
              { label: t('history.search.match.substring'), value: 'substring' }
            ]}
          />
        </SearchToolbar>
        {sortedSearchResults.length > 0 && (
          <SearchStats>
            {t('history.search.stats', { count: searchStats.count, time: searchStats.time.toFixed(3) })}
          </SearchStats>
        )}
        {searchError !== null && (
          <SearchErrorState data-testid="history-search-error" title={searchError}>
            <span>{t('history.search.failed')}</span>
            <Button size="small" onClick={() => void onSearch()}>
              {t('common.retry')}
            </Button>
          </SearchErrorState>
        )}
        <List
          itemLayout="vertical"
          dataSource={sortedSearchResults}
          data-testid="history-search-list"
          pagination={{
            pageSize: 10,
            hideOnSinglePage: true
          }}
          // `display: none` 的容器里不再保留可被读屏/自动化命中的内容（f2-60）。
          aria-hidden={!visible}
          style={{ opacity: isLoading ? 0 : 1 }}
          renderItem={({ message, topic, snippet }) => (
            <List.Item>
              <Title
                level={5}
                style={{ color: 'var(--color-primary)', cursor: 'pointer' }}
                onClick={() => onTopicClick(topic)}>
                {topic.name}
              </Title>
              <div style={{ cursor: 'pointer' }} onClick={() => onMessageClick(message)}>
                <Text style={{ whiteSpace: 'pre-line' }}>{highlightText(snippet)}</Text>
              </div>
              <SearchResultTime>
                <Text type="secondary">{new Date(message.createdAt).toLocaleString()}</Text>
              </SearchResultTime>
            </List.Item>
          )}
        />
        <div style={{ minHeight: 30 }}></div>
      </Spin>
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  height: 100%;
  padding: 20px 36px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
`

const SearchStats = styled.div`
  font-size: 13px;
  color: var(--color-text-3);
`

/** 检索失败态：与"没有结果"显式分离，并给出重试入口（二轮审查 f2-51）。 */
const SearchErrorState = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--color-error);
`

const SearchToolbar = styled.div`
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
`

const SearchResultTime = styled.div`
  margin-top: 10px;
  text-align: right;
`

export default memo(SearchResults)
