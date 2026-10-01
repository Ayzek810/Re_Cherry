import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import { TopView } from '@renderer/components/TopView'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import type { KnowledgeBaseForm } from '@renderer/hooks/useKnowledgeBaseForm'
import { useKnowledgeBaseForm } from '@renderer/hooks/useKnowledgeBaseForm'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { KnowledgeBase } from '@renderer/types'
import { formatErrorMessage } from '@renderer/utils/error'
import { Flex } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  AdvancedSettingsPanel,
  GeneralSettingsPanel,
  KnowledgeBaseFormModal,
  type PanelConfig
} from './KnowledgeSettings'

const logger = loggerService.withContext('EditKnowledgeBasePopup')

/**
 * 把表单态窄化为提交态。表单允许 `model` 为空位（`undefined` = 还没选），
 * 提交路径必须先校验再构造 `KnowledgeBase` —— 旧实现用 `model: null as any` 绕过类型系统。
 * 返回 `undefined` 表示还没选模型，调用方负责提示（不抛异常，便于在两种入口共用）。
 */
function toSubmittedBase(form: KnowledgeBaseForm): KnowledgeBase | undefined {
  if (!form.model) return undefined
  return { ...form, model: form.model }
}

interface ShowParams {
  base: KnowledgeBase
}

interface PopupContainerProps extends ShowParams {
  resolve: (data: KnowledgeBase | null) => void
}

const PopupContainer: React.FC<PopupContainerProps> = ({ base: _base, resolve }) => {
  const { t } = useTranslation()
  const { base, updateKnowledgeBase, migrateBase } = useKnowledge(_base.id)
  const {
    newBase,
    setNewBase,
    handlers,
    providerData: { selectedDocPreprocessProvider, docPreprocessSelectOptions }
  } = useKnowledgeBaseForm(_base)

  const [open, setOpen] = useState(true)

  const hasCriticalChanges = useMemo(
    () => getModelUniqId(base?.model) !== getModelUniqId(newBase?.model) || base?.dimensions !== newBase?.dimensions,
    [base, newBase]
  )

  // 处理嵌入模型更改迁移
  const handleEmbeddingModelChangeMigration = useCallback(async () => {
    const migrated = toSubmittedBase(newBase)
    if (!migrated) {
      window.toast.error(t('knowledge.embedding_model_required'))
      return
    }
    const migratedBase = { ...migrated, id: nanoid() }
    try {
      await migrateBase(migratedBase)
      setOpen(false)
      resolve(migratedBase)
    } catch (error) {
      logger.error('KnowledgeBase migration failed:', error as Error)
      window.toast.error(t('knowledge.migrate.error.failed') + ': ' + formatErrorMessage(error))
    }
  }, [newBase, migrateBase, resolve, t])

  // 这里曾是 render 体内的 `if (!base) { resolve(null); return null }`。
  // `resolve` → `this.hide()` → TopView 容器 setState，等于在一个组件渲染期间更新另一个组件
  // （React 报 "Cannot update a component while rendering a different component"；并发/StrictMode 下
  // 还可能重复 hide/resolve）。渲染分支只 `return null`，副作用挪进 effect 且只结算一次。
  const resolvedMissingBaseRef = useRef(false)
  useEffect(() => {
    if (!base && !resolvedMissingBaseRef.current) {
      resolvedMissingBaseRef.current = true
      resolve(null)
    }
  }, [base, resolve])

  const submittedBase = toSubmittedBase(newBase)

  const confirmModelChange = useCallback(() => {
    if (!submittedBase) {
      window.toast.error(t('knowledge.embedding_model_required'))
      return
    }
    void handleEmbeddingModelChangeMigration()
  }, [submittedBase, handleEmbeddingModelChangeMigration, t])

  if (!base) {
    return null
  }

  const onOk = async () => {
    if (hasCriticalChanges) {
      window.modal.confirm({
        title: t('knowledge.migrate.confirm.title'),
        content: (
          <Flex vertical align="self-start">
            <span>{t('knowledge.migrate.confirm.content')}</span>
            <span>{t('knowledge.embedding_model')}:</span>
            <span style={{ paddingLeft: '1em' }}>{`${t('knowledge.migrate.source_model')}: ${base.model.name}`}</span>
            <span
              style={{
                paddingLeft: '1em'
              }}>{`${t('knowledge.migrate.target_model')}: ${newBase.model?.name ?? ''}`}</span>
            <span>{t('knowledge.dimensions')}:</span>
            <span
              style={{ paddingLeft: '1em' }}>{`${t('knowledge.migrate.source_dimensions')}: ${base.dimensions}`}</span>
            <span
              style={{
                paddingLeft: '1em'
              }}>{`${t('knowledge.migrate.target_dimensions')}: ${newBase.dimensions}`}</span>
          </Flex>
        ),
        okText: t('knowledge.migrate.confirm.ok'),
        centered: true,
        onOk: confirmModelChange
      })
    } else {
      if (!submittedBase) {
        window.toast.error(t('knowledge.embedding_model_required'))
        return
      }
      try {
        logger.debug('newbase', submittedBase)
        updateKnowledgeBase(submittedBase)
        setOpen(false)
        resolve(submittedBase)
      } catch (error) {
        logger.error('KnowledgeBase edit failed:', error as Error)
        window.toast.error(t('knowledge.error.failed_to_edit') + formatErrorMessage(error))
      }
    }
  }

  const onCancel = () => {
    setOpen(false)
  }

  const panelConfigs: PanelConfig[] = [
    {
      key: 'general',
      label: t('settings.general.label'),
      panel: <GeneralSettingsPanel newBase={newBase} setNewBase={setNewBase} handlers={handlers} />
    },
    {
      key: 'advanced',
      label: t('settings.advanced.title'),
      panel: (
        <AdvancedSettingsPanel
          newBase={newBase}
          selectedDocPreprocessProvider={selectedDocPreprocessProvider}
          docPreprocessSelectOptions={docPreprocessSelectOptions}
          handlers={handlers}
        />
      )
    }
  ]

  return (
    <KnowledgeBaseFormModal
      title={t('knowledge.settings.title')}
      okText={hasCriticalChanges ? t('knowledge.migrate.button.text') : t('common.save')}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={() => resolve(null)}
      panels={panelConfigs}
      defaultExpandAdvanced={true}
    />
  )
}

export default class EditKnowledgeBasePopup {
  static TopViewKey = 'EditKnowledgeBasePopup'

  static hide() {
    TopView.hide(this.TopViewKey)
  }

  static show(props: ShowParams): Promise<KnowledgeBase | null> {
    return new Promise<KnowledgeBase | null>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            this.hide()
            resolve(v)
          }}
        />,
        this.TopViewKey
      )
    })
  }
}
