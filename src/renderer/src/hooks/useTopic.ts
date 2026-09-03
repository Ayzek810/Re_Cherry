import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { safeDeleteFiles } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import { setNewlyRenamedTopics, setRenamingTopics } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { find } from 'lodash'
import { useEffect, useState } from 'react'

import { useAssistant } from './useAssistant'

let _activeTopic: Topic

const logger = loggerService.withContext('useTopic')

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const [activeTopic, setActiveTopic] = useState(topic || _activeTopic || assistant?.topics[0])

  _activeTopic = activeTopic

  useEffect(() => {
    if (activeTopic) {
      void store.dispatch(loadTopicMessagesThunk(activeTopic.id))
      void EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
    }
  }, [activeTopic])

  useEffect(() => {
    // activeTopic not in assistant.topics
    // 确保 assistant 和 assistant.topics 存在，避免在数据未完全加载时访问属性
    if (
      assistant &&
      assistant.topics &&
      Array.isArray(assistant.topics) &&
      assistant.topics.length > 0 &&
      !find(assistant.topics, { id: activeTopic?.id })
    ) {
      setActiveTopic(assistant.topics[0])
    }
  }, [activeTopic?.id, assistant])

  useEffect(() => {
    if (!assistant?.topics?.length || !activeTopic) {
      return
    }

    const latestTopic = assistant.topics.find((item) => item.id === activeTopic.id)
    if (latestTopic && latestTopic !== activeTopic) {
      setActiveTopic(latestTopic)
    }
  }, [assistant?.topics, activeTopic])

  return { activeTopic, setActiveTopic }
}

export function useTopic(assistant: Assistant, topicId?: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export function getTopic(assistant: Assistant, topicId: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export async function getTopicById(topicId: string) {
  const assistants = store.getState().assistants.assistants
  const topics = assistants.map((assistant) => assistant.topics).flat()
  const topic = topics.find((topic) => topic.id === topicId)
  const messages = await TopicManager.getTopicMessages(topicId)
  return { ...topic, messages } as Topic
}

/**
 * 开始重命名指定话题
 */
export const startTopicRenaming = (topicId: string) => {
  const currentIds = store.getState().runtime.chat.renamingTopics
  if (!currentIds.includes(topicId)) {
    store.dispatch(setRenamingTopics([...currentIds, topicId]))
  }
}

/**
 * 完成重命名指定话题
 */
export const finishTopicRenaming = (topicId: string) => {
  const state = store.getState()

  // 1. 立即从 renamingTopics 移除
  const currentRenaming = state.runtime.chat.renamingTopics
  store.dispatch(setRenamingTopics(currentRenaming.filter((id) => id !== topicId)))

  // 2. 立即添加到 newlyRenamedTopics
  const currentNewlyRenamed = state.runtime.chat.newlyRenamedTopics
  store.dispatch(setNewlyRenamedTopics([...currentNewlyRenamed, topicId]))

  // 3. 延迟从 newlyRenamedTopics 移除
  setTimeout(() => {
    const current = store.getState().runtime.chat.newlyRenamedTopics
    store.dispatch(setNewlyRenamedTopics(current.filter((id) => id !== topicId)))
  }, 700)
}

// Convert class to object with functions since class only has static methods
// 只有静态方法,没必要用class，可以export {}
export const TopicManager = {
  async getTopic(id: string) {
    const state = store.getState()
    for (const assistant of state.assistants.assistants) {
      const topic = assistant.topics.find((topic) => topic.id === id)
      if (topic) return topic
    }
    return undefined
  },

  async getAllTopics() {
    const state = store.getState()
    return state.assistants.assistants.flatMap((assistant) => assistant.topics)
  },

  /**
   * 加载并返回指定话题的消息（dsh 内核替换：从内核会话加载进 Redux 后读取）
   */
  async getTopicMessages(id: string) {
    await store.dispatch(loadTopicMessagesThunk(id))
    const state = store.getState()
    return (state.messages.messageIdsByTopic[id] ?? [])
      .map((messageId) => state.messages.entities[messageId])
      .filter((message): message is Message => message !== undefined)
  },

  async removeTopic(id: string) {
    await TopicManager.clearTopicMessages(id)
    // 通知内核删除话题会话（内核持久化数据按"旧数据不管"政策保留为孤儿）
    void window.api.dshTopicDelete(id).catch((error) => {
      logger.warn(`TopicManager: failed to delete kernel session for topic ${id}`, error as Error)
    })
  },

  async clearTopicMessages(id: string): Promise<void> {
    // 从 Redux 收集并删除关联文件（Dexie 已废弃，块数据由内核事件驱动）
    const state = store.getState()
    const blockIds = (state.messages.messageIdsByTopic[id] ?? []).flatMap(
      (messageId) => state.messages.entities[messageId]?.blocks ?? []
    )
    const filesToDelete = blockIds
      .map((blockId) => state.messageBlocks.entities[blockId])
      .filter(
        (block): block is FileMessageBlock | ImageMessageBlock =>
          block !== undefined &&
          (block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE) &&
          block.file !== undefined
      )
      .map((block) => block.file)
      .filter((file): file is FileMetadata => file !== undefined)

    if (filesToDelete.length > 0) {
      await safeDeleteFiles(filesToDelete)
    }
  }
}
