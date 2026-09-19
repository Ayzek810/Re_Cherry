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
import type { Assistant, AssistantSettings, Model, Topic } from '@renderer/types'
import { isEmpty, uniqBy } from 'lodash'

import type { RootState } from '.'

export interface AssistantsState {
  defaultAssistant: Assistant
  assistants: Assistant[]
  tagsOrder: string[]
  collapsedTags: Record<string, boolean>
}

const initialState: AssistantsState = {
  defaultAssistant: getDefaultAssistant(),
  assistants: [getDefaultAssistant()],
  tagsOrder: [],
  collapsedTags: {},
}

const normalizeTopics = (topics: unknown): Topic[] => (Array.isArray(topics) ? topics : [])

/**
 * 收集这些话题及其全部 fork 后代的 id（血缘在删除根时一并消失）。
 * 删除类操作共用：removeTopic（用户删除）与 pruneTopics（内核对账剪除）。
 */
const collectSubtreeIds = (topics: Topic[], roots: string[]): Set<string> => {
  const ids = new Set<string>(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const topic of topics) {
      if (topic.parentTopicId !== undefined && ids.has(topic.parentTopicId) && !ids.has(topic.id)) {
        ids.add(topic.id)
        changed = true
      }
    }
  }
  return ids
}

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
      const idsToRemove = collectSubtreeIds(assistantTopics, [action.payload.topic.id])
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: assistantTopics.filter((topic) => !idsToRemove.has(topic.id))
            }
          : assistant
      )
    },
    /**
     * 以内核结果**剪除**渲染层陈旧行（v0.3.0-2 目标 B）：按 id 删除这些根行及其全部 fork 后代。
     *
     * 与相邻 action 的语义边界（勿混用）：
     * - `updateTopics`：以根列表**替换**并保留血缘仍成立的后代行（侧栏只操作根）；
     * - `removeTopic`：用户主动删除一个话题（含后代）；
     * - `pruneTopics`：**只**由 `services/kernelTopics.ts` 的内核对账使用——针对"上次会话留下、
     *   内核已不认识"的行。不得用于普通删除。
     */
    pruneTopics: (state, action: PayloadAction<{ assistantId: string; topicIds: string[] }>) => {
      if (action.payload.topicIds.length === 0) return
      const assistantTopics = normalizeTopics(
        state.assistants.find((assistant) => assistant.id === action.payload.assistantId)?.topics ?? []
      )
      const idsToRemove = collectSubtreeIds(assistantTopics, action.payload.topicIds)
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
        const normalizedIncoming = incoming.map((topic) =>
          isEmpty(topic.messages) ? topic : { ...topic, messages: [] }
        )
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
      // 全持有者提升（v0.3.0-5）：隔离对账前的历史污染可能让多个助手持有同 id 行，
      // first-match 只提升污染副本会让归属助手的 familyRefreshKey（图/页码条的失效签名）
      // 停留不更新 → 陈旧家族缓存。每一份持有者都提升，幂等无副作用。
      const now = new Date().toISOString()
      for (const assistant of state.assistants) {
        for (const topic of normalizeTopics(assistant.topics)) {
          if (topic.id === action.payload.topicId) {
            topic.updatedAt = now
          }
        }
      }
    },
    updateTopicName: (state, action: PayloadAction<{ topicId: string; name: string }>) => {
      // 全持有者写入（与 updateTopicUpdatedAt 同理由，v0.3.0-5）：隔离对账前的历史污染
      // 可能让多个助手持有同 id 行，只写 first-match 会让污染副本维持旧名。
      //
      // 与通用 updateTopic 的关键差异：**不 bump updatedAt**。updatedAt 在
      // familyRowSignature（页码条/分支图的家族缓存失效签名）里，而名字落定时
      // 结构/活动都没变——用 updateTopic 落名会把每次命名都变成一次全家族重取，
      // 表现为对话树数字连跳（真机 2026-09-17：dsh session/title 事件首次持续
      // 流动后暴露；v0.3.1 起调用方为 services/topicNaming.ts 的自动命名，规则
      // 不变）。名字是标签不是活动；真活动（发送/回合结束）由
      // updateTopicUpdatedAt 专门负责。
      for (const assistant of state.assistants) {
        for (const topic of normalizeTopics(assistant.topics)) {
          if (topic.id === action.payload.topicId && topic.name !== action.payload.name) {
            topic.name = action.payload.name
          }
        }
      }
    },
    /**
     * 发送时刻的"活动浮顶"写入（v0.3.1 验收轮，用户反馈：底层话题发消息后应浮到侧栏顶部）。
     *
     * - 这是**数组序的写入**，不是显示时排序：显示时排序会把拖拽/置顶的序再吞一次
     *   （v0.3.1 刚修的病根），写数组序才是唯一不被吞的落点；
     * - 只动位置，不碰任何字段（updatedAt 由成对的 updateTopicUpdatedAt 负责）——同
     *   updateTopicName 的教义：位置也不是"活动"，familyRowSignature（页码条/分支图缓存
     *   失效签名）不因本 action 变化；
     * - 全持有者写入（同 updateTopicUpdatedAt 的理由）：多持有历史污染行只搬一份，
     *   另一份所在清单的顺序就悬空了；
     * - 输入若是分支子行（用户正浏览分支时发送），搬的是**家族根行**——侧栏只显示根，
     *   分支仅通过根进入；上溯用现有行的 parentTopicId 链，链断（父行缺失）以自身为根；
     * - 已在头部（或该持有者不持有）→ no-op，不制造无意义的替换/persist 写盘。
     */
    moveTopicToHead: (state, action: PayloadAction<{ topicId: string }>) => {
      // ① 任一持有者里找到这行，沿血缘上溯到家族根
      let rootId: string | undefined
      for (const assistant of state.assistants) {
        const existing = normalizeTopics(assistant.topics)
        const self = existing.find((topic) => topic.id === action.payload.topicId)
        if (self === undefined) continue
        let row = self
        const visited = new Set<string>()
        while (row.parentTopicId !== undefined && row.parentTopicId.length > 0 && !visited.has(row.id)) {
          visited.add(row.id)
          const parent = existing.find((topic) => topic.id === row.parentTopicId)
          if (parent === undefined) break
          row = parent
        }
        rootId = row.id
        break
      }
      if (rootId === undefined) return
      // ② 全持有者：把根行搬到各自清单头部（splice+unshift 在 Immer 草稿上原位生效）
      for (const assistant of state.assistants) {
        const existing = normalizeTopics(assistant.topics)
        const index = existing.findIndex((topic) => topic.id === rootId)
        if (index <= 0) continue // -1 = 未持有；0 = 已在头部
        const [moved] = existing.splice(index, 1)
        existing.unshift(moved)
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
  pruneTopics,
  updateTopic,
  updateTopics,
  removeAllTopics,
  updateTopicUpdatedAt,
  updateTopicName,
  moveTopicToHead,
  setModel,
  setTagsOrder,
  updateAssistantSettings,
  updateTagCollapse,
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

/**
 * 话题行归属的**唯一权威判定**（v0.3.0-5）：返回实际持有该话题行的助手。
 *
 * 为什么不能信行上的 `assistantId` 字段：隔离对账前的历史污染行、以及任何没经过
 * `recordTopicView` 归一的行，该字段都可能指向别的助手。按字段找助手会拿到**错误的话题
 * 清单**——页码条/旁答条用那份清单算家族刷新签名（永远不变）与 branchKind 判定（永远
 * undefined），切页还会把重复行物化进错误助手。成员归属（"哪份清单里有这行"）才是事实。
 * @param assistants - 全部助手（store 里的 `assistants.assistants`）。
 * @param topicId - 话题行 id。
 * @returns 持有该行的助手；任何助手都没有（行已删/尚未物化）→ undefined。
 */
export function owningAssistantOfTopic(assistants: Assistant[], topicId: string): Assistant | undefined {
  return assistants.find((assistant) => normalizeTopics(assistant.topics).some((row) => row.id === topicId))
}

export default assistantsSlice.reducer
