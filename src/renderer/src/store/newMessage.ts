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
import { loggerService } from '@logger'
import type { EntityState, PayloadAction } from '@reduxjs/toolkit'
import { createEntityAdapter, createSlice } from '@reduxjs/toolkit'
// Separate type-only imports from value imports
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'

const logger = loggerService.withContext('newMessage')

// 1. Create the Adapter
const messagesAdapter = createEntityAdapter<Message>()

// 2. Define the State Interface
export interface MessagesState extends EntityState<Message, string> {
  messageIdsByTopic: Record<string, string[]> // Map: topicId -> ordered message IDs
  currentTopicId: string | null
  loadingByTopic: Record<string, boolean>
  fulfilledByTopic: Record<string, boolean>
  displayCount: number
}

// 3. Define the Initial State
const initialState: MessagesState = messagesAdapter.getInitialState({
  messageIdsByTopic: {},
  currentTopicId: null,
  loadingByTopic: {},
  fulfilledByTopic: {},
  displayCount: 10
})

// Payload for receiving messages (used by loadTopicMessagesThunk)
interface MessagesReceivedPayload {
  topicId: string
  messages: Message[]
}

// Payload for setting topic loading state
interface SetTopicLoadingPayload {
  topicId: string
  loading: boolean
}

// Payload for setting topic loading state
interface SetTopicFulfilledPayload {
  topicId: string
  fulfilled: boolean
}

// Payload for upserting a block reference
interface UpsertBlockReferencePayload {
  messageId: string
  blockId: string
  status?: MessageBlockStatus
  blockType?: MessageBlockType
}

// Payload for removing a single message
interface RemoveMessagePayload {
  topicId: string
  messageId: string
}

// Payload for removing messages by askId
interface RemoveMessagesByAskIdPayload {
  topicId: string
  askId: string
}

// Payload for remapping a message id（本地 uuid → 内核回执后的 kernel-<topic>-<seq>）
interface ReplaceMessageIdPayload {
  topicId: string
  oldId: string
  newId: string
}

// Payload for inserting a message at a specific index
interface InsertMessageAtIndexPayload {
  topicId: string
  message: Message
  index: number
}

// 4. Create the Slice with Refactored Reducers
export const messagesSlice = createSlice({
  name: 'newMessages',
  initialState,
  reducers: {
    setCurrentTopicId(state, action: PayloadAction<string | null>) {
      state.currentTopicId = action.payload
      // 刻意不播种 messageIdsByTopic（v0.3.0-5）：播种空数组 = "没加载"与"加载完的空历史"
      // 在 loadTopicMessagesThunk 的短路判定里不可区分——一次瞬时加载失败后该话题会被
      // 空数组卡住，重进也不再重拉（真机"点进话题偶发空白直到重启"的一半根源）。
      // 所有消费方对 undefined 都已容错（?? [] / 显式判 undefined）。
    },
    setTopicLoading(state, action: PayloadAction<SetTopicLoadingPayload>) {
      const { topicId, loading } = action.payload
      state.loadingByTopic[topicId] = loading
    },
    setTopicFulfilled(state, action: PayloadAction<SetTopicFulfilledPayload>) {
      const { topicId, fulfilled } = action.payload
      state.fulfilledByTopic[topicId] = fulfilled
    },
    messagesReceived(state, action: PayloadAction<MessagesReceivedPayload>) {
      const { topicId, messages } = action.payload
      // @ts-ignore ts-2589 false positive
      messagesAdapter.upsertMany(state, messages)
      state.messageIdsByTopic[topicId] = messages.map((m) => m.id)
      state.currentTopicId = topicId
    },
    addMessage(state, action: PayloadAction<{ topicId: string; message: Message }>) {
      const { topicId, message } = action.payload
      messagesAdapter.addOne(state, message)
      if (!state.messageIdsByTopic[topicId]) {
        state.messageIdsByTopic[topicId] = []
      }
      state.messageIdsByTopic[topicId].push(message.id)
      if (!(topicId in state.loadingByTopic)) {
        state.loadingByTopic[topicId] = false
      }
      if (!(topicId in state.fulfilledByTopic)) {
        state.fulfilledByTopic[topicId] = false
      }
    },
    insertMessageAtIndex(state, action: PayloadAction<InsertMessageAtIndexPayload>) {
      const { topicId, message, index } = action.payload
      messagesAdapter.addOne(state, message) // Add message to entities
      if (!state.messageIdsByTopic[topicId]) {
        state.messageIdsByTopic[topicId] = []
      }
      // Ensure index is within bounds
      const safeIndex = Math.max(0, Math.min(index, state.messageIdsByTopic[topicId].length))
      state.messageIdsByTopic[topicId].splice(safeIndex, 0, message.id) // Insert ID at specified index

      if (!(topicId in state.loadingByTopic)) {
        state.loadingByTopic[topicId] = false
      }
      if (!(topicId in state.fulfilledByTopic)) {
        state.fulfilledByTopic[topicId] = false
      }
    },
    updateMessage(
      state,
      action: PayloadAction<{
        topicId: string
        messageId: string
        updates: Partial<Message> & { blockInstruction?: { id: string; position?: number } }
      }>
    ) {
      const { messageId, updates } = action.payload
      const { blockInstruction, ...otherUpdates } = updates

      if (blockInstruction) {
        const messageToUpdate = state.entities[messageId]
        if (messageToUpdate) {
          const { id: blockIdToAdd, position } = blockInstruction
          const currentBlocks = [...(messageToUpdate.blocks || [])]
          if (!currentBlocks.includes(blockIdToAdd)) {
            if (typeof position === 'number' && position >= 0 && position <= currentBlocks.length) {
              currentBlocks.splice(position, 0, blockIdToAdd)
            } else {
              currentBlocks.push(blockIdToAdd)
            }
            messagesAdapter.updateOne(state, { id: messageId, changes: { ...otherUpdates, blocks: currentBlocks } })
          } else {
            if (Object.keys(otherUpdates).length > 0) {
              messagesAdapter.updateOne(state, { id: messageId, changes: otherUpdates })
            }
          }
        } else {
          logger.warn(`[updateMessage] Message ${messageId} not found in entities.`)
        }
      } else {
        messagesAdapter.updateOne(state, { id: messageId, changes: otherUpdates })
      }
    },
    clearTopicMessages(state, action: PayloadAction<string>) {
      const topicId = action.payload
      const idsToRemove = state.messageIdsByTopic[topicId] || []
      if (idsToRemove.length > 0) {
        messagesAdapter.removeMany(state, idsToRemove)
      }
      delete state.messageIdsByTopic[topicId]
      state.loadingByTopic[topicId] = false
      state.fulfilledByTopic[topicId] = false
    },
    removeMessage(state, action: PayloadAction<RemoveMessagePayload>) {
      const { topicId, messageId } = action.payload
      const currentTopicIds = state.messageIdsByTopic[topicId]
      if (currentTopicIds) {
        state.messageIdsByTopic[topicId] = currentTopicIds.filter((id) => id !== messageId)
      }
      messagesAdapter.removeOne(state, messageId)
    },
    removeMessagesByAskId(state, action: PayloadAction<RemoveMessagesByAskIdPayload>) {
      const { topicId, askId } = action.payload
      const currentTopicIds = state.messageIdsByTopic[topicId] || []
      const idsToRemove: string[] = []

      currentTopicIds.forEach((id) => {
        const message = state.entities[id]
        if (message && message.askId === askId) {
          idsToRemove.push(id)
        }
      })

      if (idsToRemove.length > 0) {
        messagesAdapter.removeMany(state, idsToRemove)
        state.messageIdsByTopic[topicId] = currentTopicIds.filter((id) => !idsToRemove.includes(id))
      }
    },
    upsertBlockReference(state, action: PayloadAction<UpsertBlockReferencePayload>) {
      const { messageId, blockId, status, blockType } = action.payload

      const messageToUpdate = state.entities[messageId]
      if (!messageToUpdate) {
        logger.error(`[upsertBlockReference] Message ${messageId} not found.`)
        return
      }

      const changes: Partial<Message> = {}

      // Update Block ID
      const currentBlocks = messageToUpdate.blocks || []
      if (!currentBlocks.includes(blockId)) {
        if (blockType === MessageBlockType.THINKING) {
          changes.blocks = [blockId, ...currentBlocks]
        } else {
          changes.blocks = [...currentBlocks, blockId]
        }
      }

      // Update Message Status based on Block Status
      if (status) {
        if (
          (status === MessageBlockStatus.PROCESSING || status === MessageBlockStatus.STREAMING) &&
          messageToUpdate.status !== AssistantMessageStatus.PROCESSING &&
          messageToUpdate.status !== AssistantMessageStatus.SUCCESS &&
          messageToUpdate.status !== AssistantMessageStatus.ERROR
        ) {
          changes.status = AssistantMessageStatus.PROCESSING
        } else if (status === MessageBlockStatus.ERROR) {
          changes.status = AssistantMessageStatus.ERROR
        } else if (
          status === MessageBlockStatus.SUCCESS &&
          messageToUpdate.status === AssistantMessageStatus.PROCESSING
        ) {
          // Tentative success - may need refinement
          // changes.status = AssistantMessageStatus.SUCCESS
        }
      }

      // Apply updates if any changes were made
      if (Object.keys(changes).length > 0) {
        messagesAdapter.updateOne(state, { id: messageId, changes })
      }
    },
    /** 消息 id 改写（发送时本地 uuid → 内核回执 seq 的 kernel-<topic>-<seq>）：
     * 移动实体、替换有序 id 列表中的位置，并把同一话题里 assistant 的 askId 引用一并更新。 */
    replaceMessageId(state, action: PayloadAction<ReplaceMessageIdPayload>) {
      const { topicId, oldId, newId } = action.payload
      const existing = state.entities[oldId]
      if (!existing || newId === oldId) return
      const moved: Message = { ...existing, id: newId }
      delete state.entities[oldId]
      state.entities[newId] = moved
      const list = state.messageIdsByTopic[topicId]
      if (list) {
        const index = list.indexOf(oldId)
        if (index >= 0) list[index] = newId
      }
      for (const id of Object.keys(state.entities)) {
        const message = state.entities[id]
        if (message && message.askId === oldId) {
          state.entities[id] = { ...message, askId: newId }
        }
      }
    }
  }
})

// 5. Export Actions and Reducer
export const newMessagesActions = messagesSlice.actions
export default messagesSlice.reducer

// --- Selectors ---
import { createSelector } from '@reduxjs/toolkit'
import { rootTopicIdOf } from '@renderer/utils/topicBranch'

import type { RootState } from './index' // Adjust path if necessary

// Base selector for the messages slice state
export const selectMessagesState = (state: RootState) => state.messages

// Selectors generated by createEntityAdapter
export const {
  selectAll: selectAllMessages, // Selects all messages as an array
  selectById: selectMessageById, // Selects a single message by ID
  selectIds: selectAllMessageIds, // Selects all message IDs as an array
  selectEntities: selectMessageEntities // Selects the entity dictionary { id: message }
} = messagesAdapter.getSelectors(selectMessagesState)

// Custom Selector: Selects messages for a specific topic in order
export const selectMessagesForTopic = createSelector(
  [
    selectMessageEntities, // Input 1: Get the dictionary of all messages { id: message }
    (state: RootState, topicId: string) => state.messages.messageIdsByTopic[topicId] // Input 2: Get the ordered IDs for the specific topic
  ],
  (messageEntities, topicMessageIds) => {
    // Logger.log(`[Selector selectMessagesForTopic] Running for topicId: ${topicId}`); // Uncomment for debugging selector runs
    if (!topicMessageIds) {
      return [] // Return an empty array if the topic or its IDs don't exist
    }
    // Map the ordered IDs to the actual message objects from the dictionary
    return topicMessageIds.map((id) => messageEntities[id]).filter((m): m is Message => !!m) // Filter out undefined/null in case of inconsistencies
  }
)

// ---------------------------------------------------------------------------
// 话题进行中/完成的**回合口径**信号（v0.3.1 第三轮）。
//
// 历史锚错：loadingByTopic 由发送任务队列驱动——queue 排空（内核流还远没结束）即被清
// （useMessageOperations.useTopicGenerating 的注释自证）；fulfilled 的 true 也挂在同一错
// 时刻，从未在 turn/end 落地。侧栏黄点半路熄灭、绿点提前点亮后被看没了，两个特效一起失
// 灵。修复分工：
// ① 黄点 = selectGeneratingTopicIds（下方）——PENDING/PROCESSING 的 assistant 消息
//    存在即"生成中"，写端不动、**读端折叠**到根 id；
// ② 绿点的真来源在 kernelChat.finishTurn（写入端直接写**根 id 投影**，非当前家族
//    时才置 true），清除端（HomePage/Topics effect）同域清根投影。
// ---------------------------------------------------------------------------

/**
 * 进行中回合的话题集合（发送到 turn/end 全程覆盖；PENDING = 尚未收到首字节）。
 * memoized：Set 内容不变则同引用——流式 delta 高频 dispatch 不会让侧栏白重渲染。
 *
 * **家族折叠（v0.3.1 第三轮）**：重发/旁答的回合在 fork 出的子会话 id 上记账，
 * 侧栏只渲染根行——输出统一折叠为**根 id**（`rootTopicIdOf`，Redux 行链同步上溯），
 * 侧栏按根行 id 查询即中。这修复了"重发流黄点全灭"（子会话在打字，根行不知道）。
 */
export const selectGeneratingTopicIds = createSelector(
  [
    (state: RootState) => state.messages.messageIdsByTopic,
    (state: RootState) => state.messages.entities as Record<string, Message | undefined>,
    (state: RootState) => state.assistants.assistants.flatMap((assistant) => assistant.topics ?? [])
  ],
  (idsByTopic, entities, topicRows) => {
    const result = new Set<string>()
    for (const [topicId, ids] of Object.entries(idsByTopic)) {
      if (ids === undefined) continue
      for (const id of ids) {
        const message = entities[id]
        if (message === undefined) continue
        if (message.role !== 'assistant') continue
        if (message.status === AssistantMessageStatus.PENDING || message.status === AssistantMessageStatus.PROCESSING) {
          result.add(rootTopicIdOf(topicId, topicRows))
          break
        }
      }
    }
    return result
  }
)
