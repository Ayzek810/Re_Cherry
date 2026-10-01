import { loggerService } from '@logger'
import Ellipsis from '@renderer/components/Ellipsis'
import { CopyIcon, DeleteIcon, EditIcon } from '@renderer/components/Icons'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import FileItem from '@renderer/pages/files/FileItem'
import { getProviderName } from '@renderer/services/ProviderService'
import type { KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { Button, Dropdown, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { PlusIcon } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import StatusIcon from '../components/StatusIcon'
import {
  ClickableSpan,
  FlexAlignCenter,
  ItemContainer,
  ItemHeader,
  KnowledgeEmptyView,
  RefreshIcon,
  ResponsiveButton,
  StatusIconWrapper
} from '../KnowledgeContent'

const logger = loggerService.withContext('KnowledgeUrls')

interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
}

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeUrls: FC<KnowledgeContentProps> = ({ selectedBase }) => {
  const { t } = useTranslation()

  const { base, urlItems, refreshItem, addUrl, removeItem, getProcessingStatus, updateItem } = useKnowledge(
    selectedBase.id || ''
  )

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const reversedItems = useMemo(() => [...urlItems].reverse(), [urlItems])
  const estimateSize = useCallback(() => 75, [])

  if (!base) {
    return null
  }

  const handleAddUrl = async () => {
    if (disabled) {
      return
    }

    const urlInput = await PromptPopup.show({
      title: t('knowledge.add_url'),
      message: '',
      inputPlaceholder: t('knowledge.url_placeholder'),
      inputProps: {
        rows: 10,
        onPressEnter: () => {}
      }
    })

    if (urlInput) {
      // Split input by newlines and filter out empty lines
      const urls = urlInput.split('\n').filter((url) => url.trim())
      // 二轮审查 f2-21：非法/重复输入此前被静默丢弃（`catch { continue }`）——用户一次粘贴 10 行、
      // 其中 7 行非法时界面只多 3 条，没有任何"7 条被跳过"的信号，也无法区分"我粘错了"与"程序没处理"。
      // §9「Never fail silently」+ 批量操作要报「N succeeded / M failed」：循环后一次性发真实信号。
      const invalid: string[] = []
      const duplicates: string[] = []

      for (const url of urls) {
        const trimmed = url.trim()
        try {
          new URL(trimmed)
        } catch {
          invalid.push(trimmed)
          logger.warn(`Skipped invalid URL input: ${trimmed}`)
          continue
        }
        if (urlItems.find((item) => item.content === trimmed)) {
          duplicates.push(trimmed)
          continue
        }
        addUrl(trimmed)
      }

      if (invalid.length > 0 || duplicates.length > 0) {
        window.toast.warning({
          title: t('knowledge.url_batch_skipped', {
            invalid: invalid.length,
            duplicate: duplicates.length,
            defaultValue: 'Skipped {{invalid}} invalid and {{duplicate}} duplicate URL(s)'
          }),
          key: 'url-added'
        })
        logger.warn(
          `Knowledge URL batch add skipped ${invalid.length} invalid and ${duplicates.length} duplicate entries`
        )
      }
    }
  }

  const handleEditRemark = async (item: KnowledgeItem) => {
    if (disabled) {
      return
    }

    const editedRemark: string | undefined = await PromptPopup.show({
      title: t('knowledge.edit_remark'),
      message: '',
      inputPlaceholder: t('knowledge.edit_remark_placeholder'),
      defaultValue: item.remark || '',
      inputProps: {
        maxLength: 100,
        rows: 1
      }
    })

    if (editedRemark !== undefined && editedRemark !== null) {
      updateItem({
        ...item,
        remark: editedRemark,
        updated_at: Date.now()
      })
    }
  }

  return (
    <ItemContainer>
      <ItemHeader>
        <ResponsiveButton
          type="primary"
          icon={<PlusIcon size={16} />}
          onClick={(e) => {
            e.stopPropagation()
            void handleAddUrl()
          }}
          disabled={disabled}>
          {t('knowledge.add_url')}
        </ResponsiveButton>
      </ItemHeader>
      <ItemFlexColumn>
        {urlItems.length === 0 && <KnowledgeEmptyView />}
        <DynamicVirtualList
          list={reversedItems}
          estimateSize={estimateSize}
          overscan={2}
          scrollerStyle={{ paddingRight: 2 }}
          itemContainerStyle={{ paddingBottom: 10 }}
          autoHideScrollbar>
          {(item) => (
            <FileItem
              key={item.id}
              fileInfo={{
                name: (
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'edit',
                          icon: <EditIcon size={14} />,
                          label: t('knowledge.edit_remark'),
                          onClick: () => handleEditRemark(item)
                        },
                        {
                          key: 'copy',
                          icon: <CopyIcon size={14} />,
                          label: t('common.copy'),
                          onClick: () => {
                            void navigator.clipboard.writeText(item.content as string)
                            window.toast.success(t('message.copied'))
                          }
                        }
                      ]
                    }}
                    trigger={['contextMenu']}>
                    <ClickableSpan>
                      <Tooltip title={item.content as string}>
                        <Ellipsis>
                          <a href={item.content as string} target="_blank" rel="noopener noreferrer">
                            {item.remark || (item.content as string)}
                          </a>
                        </Ellipsis>
                      </Tooltip>
                    </ClickableSpan>
                  </Dropdown>
                ),
                ext: '.url',
                extra: getDisplayTime(item),
                actions: (
                  <FlexAlignCenter>
                    {item.uniqueId && <Button type="text" icon={<RefreshIcon />} onClick={() => refreshItem(item)} />}
                    <StatusIconWrapper>
                      <StatusIcon sourceId={item.id} base={base} getProcessingStatus={getProcessingStatus} type="url" />
                    </StatusIconWrapper>
                    <Button
                      type="text"
                      danger
                      onClick={() => void removeItem(item)}
                      icon={<DeleteIcon size={14} className="lucide-custom" />}
                    />
                  </FlexAlignCenter>
                )
              }}
            />
          )}
        </DynamicVirtualList>
      </ItemFlexColumn>
    </ItemContainer>
  )
}

const ItemFlexColumn = styled.div`
  padding: 20px 16px;
  height: calc(100vh - 135px);
`

export default KnowledgeUrls
