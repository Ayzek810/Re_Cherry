/**
 * 正文块。引用管线（统一引用机制，V2 迁移）：
 * citationReferences → formatCitationsFromBlock 取 Citation[] → processContent
 *（withCitationTags 把 [n] 变 sup 药丸）→ registry out-of-band 传给 Markdown
 * 的 Link/CitationSup 挂悬浮胶囊。数据载体块不可见（不渲染为卡）。
 */
import { useSettings } from '@renderer/hooks/useSettings'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { RootState } from '@renderer/store'
import { selectFormattedCitationsByBlockId } from '@renderer/store/messageBlock'
import { type Model } from '@renderer/types'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { determineCitationSource, toTooltipCitation, withCitationTags } from '@renderer/utils/citation'
import { Flex } from 'antd'
import React, { useCallback, useMemo } from 'react'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

import Markdown from '../../Markdown/Markdown'

interface Props {
  block: MainTextMessageBlock
  citationBlockId?: string
  mentions?: Model[]
  role: Message['role']
}

const MainTextBlock: React.FC<Props> = ({ block, citationBlockId, role, mentions = [] }) => {
  const { renderInputMessageAsMarkdown } = useSettings()

  const rawCitations = useSelector((state: RootState) => selectFormattedCitationsByBlockId(state, citationBlockId))

  // 悬浮胶囊所用安全形态（清 markdown/截断）——V2 trustedCitations 同语义
  const trustedCitations = useMemo(() => rawCitations.map(toTooltipCitation), [rawCitations])

  // 创建引用处理函数，传递给 Markdown 组件在流式渲染中使用
  const processContent = useCallback(
    (rawText: string) => {
      if (!block.citationReferences?.length || !citationBlockId || rawCitations.length === 0) {
        return rawText
      }

      // 确定最适合的 source
      const sourceType = determineCitationSource(block.citationReferences)

      return withCitationTags(rawText, rawCitations, sourceType)
    },
    [block.citationReferences, citationBlockId, rawCitations]
  )

  // V2 安全加固：data-citation 只存编号，数据经 registry out-of-band 传递
  const citationRegistry = useMemo(
    () => (trustedCitations.length > 0 ? new Map(trustedCitations.map((c) => [c.number, c])) : undefined),
    [trustedCitations]
  )

  return (
    <>
      {/* Render mentions associated with the message */}
      {mentions && mentions.length > 0 && (
        <Flex gap="8px" wrap style={{ marginBottom: 10 }}>
          {mentions.map((m) => (
            <MentionTag key={getModelUniqId(m)}>{'@' + m.name}</MentionTag>
          ))}
        </Flex>
      )}
      {role === 'user' && !renderInputMessageAsMarkdown ? (
        <p className="markdown" style={{ whiteSpace: 'pre-wrap' }}>
          {block.content}
        </p>
      ) : (
        <Markdown block={block} postProcess={processContent} citationRegistry={citationRegistry} />
      )}
    </>
  )
}

const MentionTag = styled.span`
  color: var(--color-link);
`

export default React.memo(MainTextBlock)
