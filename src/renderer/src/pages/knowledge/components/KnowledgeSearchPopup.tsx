import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { TopView } from '@renderer/components/TopView'
import { searchKnowledgeBase } from '@renderer/services/knowledgeBaseApi'
import type { FileMetadata, KnowledgeBase, KnowledgeSearchResult } from '@renderer/types'
import type { InputRef } from 'antd'
import { Button, Divider, Empty, Input, List, Modal, Spin } from 'antd'
import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SearchItemRenderer from './KnowledgeSearchItem'

interface ShowParams {
  base: KnowledgeBase
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

const logger = loggerService.withContext('KnowledgeSearchPopup')

const PopupContainer: React.FC<Props> = ({ base, resolve }) => {
  const [open, setOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Array<KnowledgeSearchResult & { file: FileMetadata | null }>>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const { t } = useTranslation()
  const searchInputRef = useRef<InputRef>(null)

  const handleSearch = async (value: string) => {
    if (!value.trim()) {
      setResults([])
      setSearchKeyword('')
      setSearchError(null)
      return
    }

    setSearchKeyword(value.trim())
    setLoading(true)
    setSearchError(null)
    try {
      const searchResults = await searchKnowledgeBase(value, base)
      logger.debug(`KnowledgeSearchPopup Search Results: ${searchResults}`)
      setResults(searchResults)
    } catch (error) {
      // 检索失败**不得**渲染成"没有结果"（CLAUDE.md §9）：置错误态并给出可重试的三态之一。
      logger.error(`Failed to search knowledge base ${base.name}:`, error as Error)
      setResults([])
      setSearchError(error instanceof Error ? error.message : String(error))
      window.toast.error(t('knowledge.search_failed'))
    } finally {
      setLoading(false)
    }
  }

  const onOk = () => {
    setOpen(false)
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  KnowledgeSearchPopup.hide = onCancel

  useEffect(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [])

  return (
    <Modal
      title={null}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      width={700}
      footer={null}
      centered
      closable={false}
      transitionName="animation-move-down"
      styles={{
        content: {
          borderRadius: 20,
          padding: 0,
          overflow: 'hidden',
          paddingBottom: 12
        },
        body: {
          maxHeight: '80vh',
          overflow: 'hidden',
          padding: 0
        }
      }}>
      <HStack style={{ padding: '0 12px', marginTop: 8 }}>
        <Input
          ref={searchInputRef}
          prefix={
            <SearchIcon>
              <Search size={15} />
            </SearchIcon>
          }
          value={searchKeyword}
          placeholder={t('knowledge.search')}
          allowClear
          autoFocus
          spellCheck={false}
          style={{ paddingLeft: 0 }}
          variant="borderless"
          size="middle"
          onChange={(e) => setSearchKeyword(e.target.value)}
          onPressEnter={() => handleSearch(searchKeyword)}
        />
      </HStack>
      <Divider style={{ margin: 0, marginTop: 4, borderBlockStartWidth: 0.5 }} />

      <ResultsContainer>
        {loading ? (
          <LoadingContainer>
            <Spin size="large" />
          </LoadingContainer>
        ) : searchError !== null ? (
          // 失败态与空态显式分离（二轮审查 f2-13）：loading / error / empty 三态并列。
          <ErrorContainer data-testid="knowledge-search-error" title={searchError}>
            <span>{t('knowledge.search_failed')}</span>
            <Button size="small" onClick={() => void handleSearch(searchKeyword)}>
              {t('common.retry')}
            </Button>
          </ErrorContainer>
        ) : results.length === 0 && searchKeyword.trim() !== '' ? (
          <EmptyContainer>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('knowledge.search_no_results')} />
          </EmptyContainer>
        ) : (
          <List
            dataSource={results}
            renderItem={(item) => (
              <List.Item>
                <SearchItemRenderer item={item} searchKeyword={searchKeyword} />
              </List.Item>
            )}
          />
        )}
      </ResultsContainer>
    </Modal>
  )
}

const ResultsContainer = styled.div`
  padding: 0 16px;
  overflow-y: auto;
  max-height: 70vh;
`

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
`

/** 检索失败态（与空态分离）：一行文案 + 重试。 */
const ErrorContainer = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
  height: 200px;
  font-size: 13px;
  color: var(--color-error);
`

const EmptyContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
`

const SearchIcon = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  background-color: var(--color-background-soft);
  margin-right: 2px;
  &.back-icon {
    cursor: pointer;
    transition: background-color 0.2s;
    &:hover {
      background-color: var(--color-background-mute);
    }
  }
`

const TopViewKey = 'KnowledgeSearchPopup'

export default class KnowledgeSearchPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(props: ShowParams) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
