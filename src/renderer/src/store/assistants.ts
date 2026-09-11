/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
// @ts-nocheck
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSelector, createSlice } from '@reduxjs/toolkit'
import { DEFAULT_CONTEXTCOUNT, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import { TopicManager } from '@renderer/hooks/useTopic'
import { DEFAULT_ASSISTANT_SETTINGS, getDefaultAssistant, getDefaultTopic } from '@renderer/services/AssistantService'
import type { Assistant, AssistantPreset, AssistantSettings, Model, Topic } from '@renderer/types'
import { isEmpty, uniqBy } from 'lodash'

import type { RootState } from '.'

export interface AssistantsState {
  defaultAssistant: Assistant
  assistants: Assistant[]
  tagsOrder: string[]
  collapsedTags: Record<string, boolean>
  presets: AssistantPreset[]
}

const initialState: AssistantsState = {
  defaultAssistant: getDefaultAssistant(),
  assistants: [getDefaultAssistant()],
  tagsOrder: [],
  collapsedTags: {},
  presets: []
}

const normalizeTopics = (topics: unknown): Topic[] => (Array.isArray(topics) ? topics : [])

const assistantsSlice = createSlice({
  name: 'assistants',
  initialState,
  reducers: {
    updateDefaultAssistant: (state, action: PayloadAction<{ assistant: Assistant }>) => {
      // @ts-ignore ts2589
      state.defaultAssistant = action.payload.assistant
    },
    updateAssistants: (state, action: PayloadAction<Assistant[]>) => {
      state.assistants = action.payload
    },
    addAssistant: (state, action: PayloadAction<Assistant>) => {
      state.assistants.unshift(action.payload)
    },
    insertAssistant: (state, action: PayloadAction<{ index: number; assistant: Assistant }>) => {
      const { index, assistant } = action.payload

      if (index < 0 || index > state.assistants.length) {
        throw new Error(`InsertAssistant: index ${index} is out of bounds [0, ${state.assistants.length}]`)
      }

      state.assistants.splice(index, 0, assistant)
    },
    removeAssistant: (state, action: PayloadAction<{ id: string }>) => {
      state.assistants = state.assistants.filter((c) => c.id !== action.payload.id)
    },
    updateAssistant: (state, action: PayloadAction<Partial<Assistant> & { id: string }>) => {
      const { id, ...update } = action.payload
      // @ts-ignore ts2589
      state.assistants = state.assistants.map((c) => (c.id === id ? { ...c, ...update } : c))
    },
    updateAssistantSettings: (
      state,
      action: PayloadAction<{ assistantId: string; settings: Partial<AssistantSettings> }>
    ) => {
      for (const assistant of state.assistants) {
        const settings = action.payload.settings
        if (assistant.id === action.payload.assistantId) {
          for (const key in settings) {
            if (!assistant.settings) {
              assistant.settings = {
                temperature: DEFAULT_TEMPERATURE,
                contextCount: DEFAULT_CONTEXTCOUNT,
                enableMaxTokens: false,
                maxTokens: 0,
                streamOutput: true
              }
            }
            assistant.settings[key] = settings[key]
          }
        }
      }
    },
    setTagsOrder: (state, action: PayloadAction<string[]>) => {
      const newOrder = action.payload
      state.tagsOrder = newOrder
      const prevCollapsed = state.collapsedTags || {}
      const updatedCollapsed: Record<string, boolean> = { ...prevCollapsed }
      newOrder.forEach((tag) => {
        if (!(tag in updatedCollapsed)) {
          updatedCollapsed[tag] = false
        }
      })
      state.collapsedTags = updatedCollapsed
    },
    updateTagCollapse: (state, action: PayloadAction<string>) => {
      const tag = action.payload
      const prev = state.collapsedTags || {}
      state.collapsedTags = {
        ...prev,
        [tag]: !prev[tag]
      }
    },
    addTopic: (state, action: PayloadAction<{ assistantId: string; topic: Topic }>) => {
      const topic = action.payload.topic
      topic.createdAt = topic.createdAt || new Date().toISOString()
      topic.updatedAt = topic.updatedAt || new Date().toISOString()
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: uniqBy([topic, ...normalizeTopics(assistant.topics)], 'id')
            }
          : assistant
      )
    },
    removeTopic: (state, action: PayloadAction<{ assistantId: string; topic: Topic }>) => {
      // 级联删除该话题 fork 出的全部子分支行（血缘在删除根时一并消失）
      const assistantTopics = normalizeTopics(
        state.assistants.find((assistant) => assistant.id === action.payload.assistantId)?.topics ?? []
      )
      const idsToRemove = new Set<string>([action.payload.topic.id])
      let changed = true
      while (changed) {
        changed = false
        for (const topic of assistantTopics) {
          if (topic.parentTopicId !== undefined && idsToRemove.has(topic.parentTopicId) && !idsToRemove.has(topic.id)) {
            idsToRemove.add(topic.id)
            changed = true
          }
        }
      }
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: assistantTopics.filter((topic) => !idsToRemove.has(topic.id))
            }
          : assistant
      )
    },
    updateTopic: (state, action: PayloadAction<{ assistantId: string; topic: Topic }>) => {
      const newTopic = action.payload.topic
      newTopic.updatedAt = new Date().toISOString()
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: normalizeTopics(assistant.topics).map((topic) => {
                const _topic = topic.id === newTopic.id ? newTopic : topic
                _topic.messages = []
                return _topic
              })
            }
          : assistant
      )
    },
    updateTopics: (state, action: PayloadAction<{ assistantId: string; topics: Topic[] }>) => {
      state.assistants = state.assistants.map((assistant) => {
        if (assistant.id !== action.payload.assistantId) return assistant
        const incoming = action.payload.topics
        // 侧栏等只操作"根话题"列表；fork 子分支行在更新时必须保留（血缘根若仍存在），避免误删
        const existing = normalizeTopics(assistant.topics)
        const incomingIds = new Set(incoming.map((topic) => topic.id))
        const keptChildren = existing.filter((topic) => {
          if (topic.parentTopicId === undefined) return false
          let parent = existing.find((candidate) => candidate.id === topic.parentTopicId)
          const visited = new Set<string>()
          while (parent !== undefined && parent.parentTopicId !== undefined && !visited.has(parent.id)) {
            visited.add(parent.id)
            parent = existing.find((candidate) => candidate.id === parent.parentTopicId)
          }
          return parent !== undefined && incomingIds.has(parent.id)
        })
        const normalizedIncoming = incoming.map((topic) => (isEmpty(topic.messages) ? topic : { ...topic, messages: [] }))
        const merged = uniqBy([...normalizedIncoming, ...keptChildren], 'id')
        return { ...assistant, topics: merged }
      })
    },
    removeAllTopics: (state, action: PayloadAction<{ assistantId: string }>) => {
      state.assistants = state.assistants.map((assistant) => {
        if (assistant.id === action.payload.assistantId) {
          normalizeTopics(assistant.topics).forEach((topic) => TopicManager.removeTopic(topic.id))
          return {
            ...assistant,
            topics: [getDefaultTopic(assistant.id)]
          }
        }
        return assistant
      })
    },
    updateTopicUpdatedAt: (state, action: PayloadAction<{ topicId: string }>) => {
      outer: for (const assistant of state.assistants) {
        for (const topic of normalizeTopics(assistant.topics)) {
          if (topic.id === action.payload.topicId) {
            topic.updatedAt = new Date().toISOString()
            break outer
          }
        }
      }
    },
    setModel: (state, action: PayloadAction<{ assistantId: string; model: Model }>) => {
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              model: action.payload.model
            }
          : assistant
      )
    },
    // Assistant Presets
    setAssistantPresets: (state, action: PayloadAction<AssistantPreset[]>) => {
      const presets = action.payload
      state.presets = []
      presets.forEach((p) => {
        state.presets.push(p)
      })
    },
    addAssistantPreset: (state, action: PayloadAction<AssistantPreset>) => {
      state.presets.push(action.payload)
    },
    removeAssistantPreset: (state, action: PayloadAction<{ id: string }>) => {
      state.presets = state.presets.filter((c) => c.id !== action.payload.id)
    },
    updateAssistantPreset: (state, action: PayloadAction<AssistantPreset>) => {
      const preset = action.payload
      const index = state.presets.findIndex((a) => a.id === preset.id)
      if (index !== -1) {
        state.presets[index] = preset
      }
    },
    updateAssistantPresetSettings: (
      state,
      action: PayloadAction<{ assistantId: string; settings: Partial<AssistantSettings> }>
    ) => {
      for (const agent of state.presets) {
        const settings = action.payload.settings
        if (agent.id === action.payload.assistantId) {
          for (const key in settings) {
            if (!agent.settings) {
              agent.settings = { ...DEFAULT_ASSISTANT_SETTINGS }
            }
            agent.settings[key] = settings[key]
          }
        }
      }
    }
  }
})

export const {
  updateDefaultAssistant,
  updateAssistants,
  addAssistant,
  insertAssistant,
  removeAssistant,
  updateAssistant,
  addTopic,
  removeTopic,
  updateTopic,
  updateTopics,
  removeAllTopics,
  updateTopicUpdatedAt,
  setModel,
  setTagsOrder,
  updateAssistantSettings,
  updateTagCollapse,
  setAssistantPresets,
  addAssistantPreset,
  removeAssistantPreset,
  updateAssistantPreset,
  updateAssistantPresetSettings
} = assistantsSlice.actions

export const selectAllTopics = createSelector([(state: RootState) => state.assistants.assistants], (assistants) =>
  assistants.flatMap((assistant: Assistant) => normalizeTopics(assistant.topics))
)

export const selectTopicsMap = createSelector([selectAllTopics], (topics) => {
  return topics.reduce((map, topic) => {
    map.set(topic.id, topic)
    return map
  }, new Map())
})

export default assistantsSlice.reducer
