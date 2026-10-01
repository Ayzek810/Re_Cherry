import { CopyOutlined } from '@ant-design/icons'
import type { FileMetadata, KnowledgeSearchResult } from '@renderer/types'
import { Tooltip, Typography } from 'antd'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton, MetadataContainer, ScoreTag, TagContainer } from '.'
import { useCopyText, useKnowledgeItemMetadata } from './hooks'

const { Text } = Typography

interface KnowledgeItemMetadataProps {
  item: KnowledgeSearchResult & {
    file: FileMetadata | null
  }
}

export const KnowledgeItemMetadata: React.FC<KnowledgeItemMetadataProps> = ({ item }) => {
  const { getSourceLink } = useKnowledgeItemMetadata()
  const { t } = useTranslation()

  const sourceLink = getSourceLink(item)

  return (
    <MetadataContainer>
      <Text type="secondary">
        {t('knowledge.source')}:{' '}
        <a href={sourceLink.href} target="_blank" rel="noreferrer">
          {sourceLink.text}
        </a>
      </Text>
      {item.score !== 0 && (
        <ScoreTag>
          {t('knowledge.score', { defaultValue: 'Score' })}: {(item.score * 100).toFixed(1)}%
        </ScoreTag>
      )}
    </MetadataContainer>
  )
}

interface CopyButtonContainerProps {
  textToCopy: string
  tooltipTitle?: string
}

export const CopyButtonContainer: React.FC<CopyButtonContainerProps> = ({ textToCopy, tooltipTitle }) => {
  const { t } = useTranslation()
  const { handleCopy } = useCopyText()
  // 默认值曾是硬编码英文 `'Copy'`——中文界面下漏译，且第三个调用点必然踩到。
  // 缺省回落到 i18n 的 `common.copy`。
  const title = tooltipTitle ?? t('common.copy')

  return (
    <TagContainer>
      <Tooltip title={title}>
        <CopyButton onClick={() => handleCopy(textToCopy)}>
          <CopyOutlined />
        </CopyButton>
      </Tooltip>
    </TagContainer>
  )
}
