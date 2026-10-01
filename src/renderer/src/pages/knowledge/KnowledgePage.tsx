import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { DraggableList } from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import ListItem from '@renderer/components/ListItem'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import Scrollbar from '@renderer/components/Scrollbar'
import { useKnowledgeBases } from '@renderer/hooks/useKnowledge'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import KnowledgeSearchPopup from '@renderer/pages/knowledge/components/KnowledgeSearchPopup'
import type { KnowledgeBase } from '@renderer/types'
import type { MenuProps } from 'antd'
import { Dropdown, Empty } from 'antd'
import { Book, Plus, Settings } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import AddKnowledgeBasePopup from './components/AddKnowledgeBasePopup'
import EditKnowledgeBasePopup from './components/EditKnowledgeBasePopup'
import KnowledgeContent from './KnowledgeContent'

const logger = loggerService.withContext('KnowledgePage')

const KnowledgePage: FC = () => {
  const { t } = useTranslation()
  const { bases, renameKnowledgeBase, deleteKnowledgeBase, updateKnowledgeBases } = useKnowledgeBases()
  const [selectedBase, setSelectedBase] = useState<KnowledgeBase | undefined>(bases[0])
  const [isDragging, setIsDragging] = useState(false)

  const handleAddKnowledge = useCallback(async () => {
    const newBase = await AddKnowledgeBasePopup.show({ title: t('knowledge.add.title') })
    if (newBase) {
      setSelectedBase(newBase)
    }
  }, [t])

  const handleEditKnowledgeBase = useCallback(async (base: KnowledgeBase) => {
    const newBase = await EditKnowledgeBasePopup.show({ base })
    // 二轮审查 f2-26：这里曾只在 `newBase.id !== base.id`（迁移换库）时更新——普通编辑（同 id）
    // 让 `selectedBase` 长期指向编辑前的旧对象。它被传给 `KnowledgeSearchPopup.show`，
    // 而 `knowledgeBaseApi.searchKnowledgeBase` 直接用传入对象的 `threshold`/`documentCount`
    // 做阈值过滤与截断 → 页面快捷键打开的检索用**旧阈值/旧截断数**，与导航栏图标入口行为不一致，
    // 表现为"设置了不生效"。改为编辑返回后无条件采用新对象。
    if (newBase) {
      setSelectedBase(newBase)
    }
  }, [])

  useEffect(() => {
    const hasSelectedBase = bases.find((base) => base.id === selectedBase?.id)
    !hasSelectedBase && setSelectedBase(bases[0])
  }, [bases, selectedBase])

  // 二轮审查 f2-26（第二面）：`selectedBase` 是快照，库里同一 id 的对象被别处更新（改名、改
  // threshold/documentCount、预处理回填）后它不会跟着变。这里在 `bases` 换引用时把新对象同步回来，
  // 保证页面快捷键检索（`KnowledgeSearchPopup.show({ base: selectedBase })`）用的是当前配置。
  // 只在"同一 id 的对象引用变了"时 setState，故不会自持成环。
  useEffect(() => {
    if (!selectedBase) return
    const current = bases.find((base) => base.id === selectedBase.id)
    if (current && current !== selectedBase) {
      setSelectedBase(current)
    }
  }, [bases, selectedBase])

  const getMenuItems = useCallback(
    (base: KnowledgeBase) => {
      const menus: MenuProps['items'] = [
        {
          label: t('knowledge.rename'),
          key: 'rename',
          icon: <EditIcon size={14} />,
          async onClick() {
            const name = await PromptPopup.show({
              title: t('knowledge.rename'),
              message: '',
              defaultValue: base.name || ''
            })
            if (name && base.name !== name) {
              renameKnowledgeBase(base.id, name)
            }
          }
        },
        {
          label: t('common.settings'),
          key: 'settings',
          icon: <Settings size={14} />,
          onClick: () => handleEditKnowledgeBase(base)
        },
        { type: 'divider' },
        {
          label: t('common.delete'),
          danger: true,
          key: 'delete',
          icon: <DeleteIcon size={14} className="lucide-custom" />,
          onClick: () => {
            window.modal.confirm({
              title: t('knowledge.delete_confirm'),
              centered: true,
              // r2-10：`deleteKnowledgeBase` 返回 `Promise<boolean>`。必须等真实结果再改选中态：
              // 旧写法先 `setSelectedBase(undefined)` 再 `void` 掉 promise，删除失败时界面停在
              // 「库还在、主区却没有选中项」的分歧态，用户以为已经删掉了。
              onOk: async () => {
                try {
                  const deleted = await deleteKnowledgeBase(base.id)
                  setSelectedBase(deleted ? undefined : base)
                } catch (error) {
                  // hook 承诺不 reject；走到这里说明投影阶段出了意外，同样不得静默。
                  logger.error(`Failed to delete knowledge base ${base.id}`, error as Error)
                  window.toast.error(t('knowledge.delete_base_failed'))
                  setSelectedBase(base)
                }
              }
            })
          }
        }
      ]

      return menus
    },
    [deleteKnowledgeBase, handleEditKnowledgeBase, renameKnowledgeBase, t]
  )

  useShortcut('search_message', () => {
    if (selectedBase) {
      void KnowledgeSearchPopup.show({ base: selectedBase }).then()
    }
  })

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('knowledge.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <KnowledgeSideNav>
          <DraggableList
            list={bases}
            onUpdate={updateKnowledgeBases}
            style={{ marginBottom: 0, paddingBottom: isDragging ? 50 : 0 }}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={() => setIsDragging(false)}>
            {(base: KnowledgeBase) => (
              <Dropdown menu={{ items: getMenuItems(base) }} trigger={['contextMenu']} key={base.id}>
                <div>
                  <ListItem
                    active={selectedBase?.id === base.id}
                    icon={<Book size={16} />}
                    title={base.name}
                    onClick={() => setSelectedBase(base)}
                  />
                </div>
              </Dropdown>
            )}
          </DraggableList>
          {!isDragging && (
            <AddKnowledgeItem onClick={handleAddKnowledge}>
              <AddKnowledgeName>
                <Plus size={18} />
                {t('button.add')}
              </AddKnowledgeName>
            </AddKnowledgeItem>
          )}
          <div style={{ minHeight: '10px' }}></div>
        </KnowledgeSideNav>
        {bases.length === 0 ? (
          <MainContent>
            <Empty description={t('knowledge.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </MainContent>
        ) : selectedBase ? (
          <KnowledgeContent selectedBase={selectedBase} />
        ) : null}
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 100%;
`

const MainContent = styled(Scrollbar)`
  padding: 15px 20px;
  display: flex;
  width: 100%;
  flex-direction: column;
  padding-bottom: 50px;
`

const KnowledgeSideNav = styled(Scrollbar)`
  display: flex;
  flex-direction: column;

  width: calc(var(--settings-width) + 100px);
  border-right: 0.5px solid var(--color-border);
  padding: 12px 10px;

  .ant-menu {
    border-inline-end: none !important;
    background: transparent;
    flex: 1;
  }

  .ant-menu-item {
    height: 40px;
    line-height: 40px;
    margin: 4px 0;
    width: 100%;

    &:hover {
      background-color: var(--color-background-soft);
    }

    &.ant-menu-item-selected {
      background-color: var(--color-background-soft);
      color: var(--color-primary);
    }
  }

  > div {
    margin-bottom: 8px;

    &:last-child {
      margin-bottom: 0;
    }
  }
`

const AddKnowledgeItem = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  padding: 7px 12px;
  position: relative;
  border-radius: var(--list-item-border-radius);
  border: 0.5px solid transparent;
  cursor: pointer;
  &:hover {
    background-color: var(--color-background-soft);
  }
`

const AddKnowledgeName = styled.div`
  color: var(--color-text);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
`

export default KnowledgePage
