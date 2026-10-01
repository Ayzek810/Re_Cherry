import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import { getEmbeddingMaxContext } from '@renderer/config/embedings'
import { usePreprocessProviders } from '@renderer/hooks/usePreprocess'
import { useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { KnowledgeBase, Model } from '@renderer/types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('useKnowledgeBaseForm')

/**
 * 表单态（r2-69）：`model` 在这里是「用户还没选」的空位（`undefined`），而不是
 * `KnowledgeBase.model` 要求的已定模型。旧实现写 `model: null as any`，把这段窗口
 * 藏出类型系统之外：编译器无法再强制提交路径的校验，而 `KnowledgeBase.model` 的
 * 消费方会在"未选择"期间拿到 `null`（家规：`null` = no answer，`undefined` = retry later），
 * 属于三值契约混用。提交路径负责窄化（`AddKnowledgeBasePopup.onOk` 先校验再构造
 * `KnowledgeBase`）。
 */
export type KnowledgeBaseForm = Omit<KnowledgeBase, 'model'> & { model?: Model }

const createInitialKnowledgeBase = (): KnowledgeBaseForm => ({
  id: nanoid(),
  name: '',
  model: undefined,
  items: [],
  created_at: Date.now(),
  updated_at: Date.now(),
  version: 1
})

/**
 * A hook that manages the state and handlers for a knowledge base form.
 *
 * The hook provides:
 * - A state object `newBase` that tracks the current form values.
 * - A function `setNewBase` to update the form state.
 * - A set of handlers for various form actions:
 *   - `handleEmbeddingModelChange`: Updates the embedding model.
 *   - `handleRerankModelChange`: Updates the rerank model.
 *   - `handleDimensionChange`: Updates the dimensions.
 *   - `handleDocPreprocessChange`: Updates the document preprocess provider.
 *   - `handleChunkSizeChange`: Updates the chunk size.
 *   - `handleChunkOverlapChange`: Updates the chunk overlap.
 *   - `handleThresholdChange`: Updates the threshold.
 * @param base - The base knowledge base to use as the initial state. If not provided, an empty base will be used.
 * @returns An object containing the new base state, a function to update the base, and handlers for various form actions.
 *          Also includes provider data for dropdown options and selected provider.
 */
export const useKnowledgeBaseForm = (base?: KnowledgeBase) => {
  const { t } = useTranslation()
  const [newBase, setNewBase] = useState<KnowledgeBaseForm>(base || createInitialKnowledgeBase())
  const { providers } = useProviders()
  const { preprocessProviders } = usePreprocessProviders()

  useEffect(() => {
    if (base) {
      setNewBase(base)
    }
  }, [base])

  const selectedDocPreprocessProvider = useMemo(
    () => newBase.preprocessProvider?.provider,
    [newBase.preprocessProvider]
  )

  const docPreprocessSelectOptions = useMemo(() => {
    const preprocessOptions = {
      label: t('settings.tool.preprocess.provider'),
      title: t('settings.tool.preprocess.provider'),
      options: preprocessProviders
        .filter((p) => p.apiKey !== '' || ['mineru', 'open-mineru', 'paddleocr'].includes(p.id))
        .map((p) => ({ value: p.id, label: p.name }))
    }
    return [preprocessOptions]
  }, [preprocessProviders, t])

  const handleEmbeddingModelChange = useCallback(
    (value: string) => {
      const model = providers.flatMap((p) => p.models).find((m) => getModelUniqId(m) === value)
      if (model) {
        setNewBase((prev) => ({ ...prev, model }))
      }
    },
    [providers]
  )

  const handleRerankModelChange = useCallback(
    (value: string) => {
      const rerankModel = value
        ? providers.flatMap((p) => p.models).find((m) => getModelUniqId(m) === value)
        : undefined
      setNewBase((prev) => ({ ...prev, rerankModel }))
    },
    [providers]
  )

  const handleDimensionChange = useCallback((value: number | null) => {
    setNewBase((prev) => ({ ...prev, dimensions: value || undefined }))
  }, [])

  const handleDocPreprocessChange = useCallback(
    (value: string) => {
      const provider = preprocessProviders.find((p) => p.id === value)
      if (!provider) {
        setNewBase((prev) => ({ ...prev, preprocessProvider: undefined }))
        return
      }
      setNewBase((prev) => ({
        ...prev,
        preprocessProvider: {
          type: 'preprocess',
          provider
        }
      }))
    },
    [preprocessProviders]
  )

  const handleChunkSizeChange = useCallback(
    (value: number | null) => {
      const modelId = newBase.model?.id || base?.model?.id
      if (!modelId) return
      const maxContext = getEmbeddingMaxContext(modelId)
      // 三值契约（r2-82 的消费侧，跨区请求⑬）：
      //  · 数值   = 确定上限 → 校验；
      //  · `null` = 「没有答案」（这个嵌入模型的上限查不到）。**不得**当成「没有上限」静默放过：
      //             必须给用户可见信号（旧实现让它落进 `!maxContext` 分支，失败伪装成通过）；
      //  · `undefined` = 「不适用/稍后重试」→ 沿用原有的无上限路径，不校验也不提示。
      if (maxContext === null) {
        logger.warn(`knowledge form: embedding max context is unknown for model "${modelId}"; chunk size not validated`)
        window.toast.warning(t('message.error.chunk_size_unknown_limit'))
        setNewBase((prev) => ({ ...prev, chunkSize: value || undefined }))
        return
      }
      if (maxContext === undefined) {
        // 不适用：没有可判定的上限，任何值都不该被拒绝，也不该打扰用户。
        setNewBase((prev) => ({ ...prev, chunkSize: value || undefined }))
        return
      }
      if (!value || value <= maxContext) {
        setNewBase((prev) => ({ ...prev, chunkSize: value || undefined }))
      } else {
        window.toast.error(t('message.error.chunk_size_too_large', { limit: maxContext }))
      }
    },
    [newBase.model, base?.model, t]
  )

  const handleChunkOverlapChange = useCallback(
    (value: number | null) => {
      if (!value || (newBase.chunkSize && newBase.chunkSize > value)) {
        setNewBase((prev) => ({ ...prev, chunkOverlap: value || undefined }))
      } else {
        window.toast.error(t('message.error.chunk_overlap_too_large'))
      }
    },
    [newBase.chunkSize, t]
  )

  const handleThresholdChange = useCallback((value: number | null) => {
    setNewBase((prev) => ({ ...prev, threshold: value || undefined }))
  }, [])

  const handlers = {
    handleEmbeddingModelChange,
    handleRerankModelChange,
    handleDimensionChange,
    handleDocPreprocessChange,
    handleChunkSizeChange,
    handleChunkOverlapChange,
    handleThresholdChange
  }

  const providerData = {
    providers,
    preprocessProviders,
    selectedDocPreprocessProvider,
    docPreprocessSelectOptions
  }

  return { newBase, setNewBase, handlers, providerData }
}
