import { loggerService } from '@logger'
import { isSupportedReasoningEffortModel, isSupportedThinkingTokenModel } from '@renderer/config/models'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addAssistant,
  addTopic,
  insertAssistant,
  removeAllTopics,
  removeAssistant,
  removeTopic,
  setModel,
  updateAssistant,
  updateAssistants,
  updateAssistantSettings as _updateAssistantSettings,
  updateDefaultAssistant,
  updateTopic,
  updateTopics
} from '@renderer/store/assistants'
import { setDefaultModel, setImageDescriberModel, setImageDescriberPrompt, setQuickModel } from '@renderer/store/llm'
import type { Assistant, AssistantSettings, Model, ThinkingOption, Topic } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { reasoningOptionsForModel } from '@renderer/utils/reasoningKernel'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { TopicManager } from './useTopic'

export function useAssistants() {
  const { t } = useTranslation()
  const { assistants } = useAppSelector((state) => state.assistants)
  const dispatch = useAppDispatch()
  const logger = loggerService.withContext('useAssistants')

  return {
    assistants,
    updateAssistants: (assistants: Assistant[]) => dispatch(updateAssistants(assistants)),
    addAssistant: (assistant: Assistant) => dispatch(addAssistant(assistant)),
    insertAssistant: (index: number, assistant: Assistant) => dispatch(insertAssistant({ index, assistant })),
    copyAssistant: (assistant: Assistant): Assistant | undefined => {
      if (!assistant) {
        logger.error("assistant doesn't exists.")
        return
      }
      const index = assistants.findIndex((_assistant) => _assistant.id === assistant.id)
      const _assistant: Assistant = { ...assistant, id: uuid(), topics: [getDefaultTopic(assistant.id)] }
      if (index === -1) {
        logger.warn("Origin assistant's id not found. Fallback to addAssistant.")
        dispatch(addAssistant(_assistant))
      } else {
        // 插入到后面
        try {
          dispatch(insertAssistant({ index: index + 1, assistant: _assistant }))
        } catch (e) {
          logger.error('Failed to insert assistant', e as Error)
          window.toast.error(t('message.error.copy'))
        }
      }
      return _assistant
    },
    removeAssistant: (id: string) => {
      dispatch(removeAssistant({ id }))
      const assistant = assistants.find((a) => a.id === id)
      const topics = assistant?.topics || []
      topics.forEach(({ id }) => TopicManager.removeTopic(id))
    }
  }
}

export function useAssistant(id: string) {
  const assistant = useAppSelector((state) => state.assistants.assistants.find((a) => a.id === id) as Assistant)
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const { defaultModel } = useDefaultModel()

  const model = useMemo(() => assistant?.model ?? assistant?.defaultModel ?? defaultModel, [assistant, defaultModel])
  if (!model) {
    throw new Error(`Assistant model is not set for assistant with name: ${assistant?.name ?? 'unknown'}`)
  }

  const normalizedTopics = useMemo(
    () => (Array.isArray(assistant?.topics) ? assistant.topics : []),
    [assistant?.topics]
  )
  const assistantWithModel = useMemo(
    () => ({ ...assistant, model, topics: normalizedTopics }),
    [assistant, model, normalizedTopics]
  )

  const settingsRef = useRef(assistant?.settings)

  useEffect(() => {
    settingsRef.current = assistant?.settings
  }, [assistant?.settings])

  const updateAssistantSettings = useCallback(
    (settings: Partial<AssistantSettings>) => {
      assistant?.id && dispatch(_updateAssistantSettings({ assistantId: assistant.id, settings }))
    },
    [assistant?.id, dispatch]
  )

  // 当model变化时，同步reasoning effort为模型支持的合法值
  useEffect(() => {
    const settings = settingsRef.current
    if (settings) {
      const currentReasoningEffort = settings.reasoning_effort
      if (isSupportedThinkingTokenModel(model) || isSupportedReasoningEffortModel(model)) {
        const supportedOptions = reasoningOptionsForModel(model)
        if (supportedOptions.every((option) => option !== currentReasoningEffort)) {
          const cache = settings.reasoning_effort_cache
          let fallbackOption: ThinkingOption

          // 选项不支持时，首先尝试恢复到上次使用的值
          if (cache && supportedOptions.includes(cache)) {
            fallbackOption = cache
          } else {
            // 灵活回退到支持的值
            // 注意：这里假设可用的options不会为空
            const enableThinking =
              currentReasoningEffort !== undefined &&
              currentReasoningEffort !== 'none' &&
              currentReasoningEffort !== 'default'
            fallbackOption = enableThinking ? 'low' : 'auto'
          }

          updateAssistantSettings({
            reasoning_effort: fallbackOption === 'none' ? undefined : fallbackOption,
            reasoning_effort_cache: fallbackOption === 'none' ? undefined : fallbackOption,
            qwenThinkMode: fallbackOption === 'none' ? undefined : true
          })
        } else {
          // 对于支持的选项, 不再更新 cache.
        }
      } else {
        // 切换到非思考模型时保留cache
        updateAssistantSettings({
          reasoning_effort: undefined,
          reasoning_effort_cache: currentReasoningEffort,
          qwenThinkMode: undefined
        })
      }
    }
  }, [model, updateAssistantSettings])

  return {
    assistant: assistantWithModel,
    model,
    addTopic: (topic: Topic) => dispatch(addTopic({ assistantId: assistant.id, topic })),
    /**
     * 删除一个话题。**乐观删除 + 失败回滚**（v0.3.0-2 §6.9）：行立刻消失（体验不变），
     * 内核若没删掉就把行放回去并提示——不留下"渲染层已删、内核还在"的分歧
     * （那正是真机上"删过的话题又回来"的来源）。
     */
    removeTopic: (topic: Topic) => {
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
      void TopicManager.removeTopic(topic.id).then((deleted) => {
        if (deleted) return
        dispatch(addTopic({ assistantId: assistant.id, topic }))
        window.toast.error(t('chat.topics.manage.delete.error'))
      })
    },
    moveTopic: (topic: Topic, toAssistant: Assistant) => {
      dispatch(addTopic({ assistantId: toAssistant.id, topic: { ...topic, assistantId: toAssistant.id } }))
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
    },
    updateTopic: (topic: Topic) => dispatch(updateTopic({ assistantId: assistant.id, topic })),
    updateTopics: (topics: Topic[]) => dispatch(updateTopics({ assistantId: assistant.id, topics })),
    removeAllTopics: () => dispatch(removeAllTopics({ assistantId: assistant.id })),
    setModel: useCallback(
      (model: Model) => assistant && dispatch(setModel({ assistantId: assistant?.id, model })),
      [assistant, dispatch]
    ),
    updateAssistant: useCallback(
      (update: Partial<Omit<Assistant, 'id'>>) => dispatch(updateAssistant({ id, ...update })),
      [dispatch, id]
    ),
    updateAssistantSettings
  }
}

export function useDefaultAssistant() {
  const defaultAssistant = useAppSelector((state) => state.assistants.defaultAssistant)
  const dispatch = useAppDispatch()
  const memoizedTopics = useMemo(() => [getDefaultTopic(defaultAssistant.id)], [defaultAssistant.id])

  return {
    defaultAssistant: {
      ...defaultAssistant,
      topics: memoizedTopics
    },
    updateDefaultAssistant: (assistant: Assistant) => dispatch(updateDefaultAssistant({ assistant }))
  }
}

export function useDefaultModel() {
  const { defaultModel, quickModel, imageDescriberModel, imageDescriberPrompt } = useAppSelector((state) => state.llm)
  const dispatch = useAppDispatch()

  return {
    defaultModel,
    quickModel,
    // 转述模型（v0.3.1 识图通道补全）：undefined = 关闭；Settings 默认模型第三栏读写。
    imageDescriberModel,
    // 转述提示词（设置弹窗）：'' = 内置默认。
    imageDescriberPrompt,
    setDefaultModel: (model: Model) => dispatch(setDefaultModel({ model })),
    setQuickModel: (model: Model) => dispatch(setQuickModel({ model })),
    setImageDescriberModel: (model: Model | undefined) => dispatch(setImageDescriberModel({ model })),
    setImageDescriberPrompt: (prompt: string) => dispatch(setImageDescriberPrompt(prompt))
  }
}
