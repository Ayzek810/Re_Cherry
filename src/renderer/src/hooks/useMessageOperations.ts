import { loggerService } from '@logger'
import { createSelector } from '@reduxjs/toolkit'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { forkBranchToKernel } from '@renderer/services/kernelChat'
import { getUserMessage } from '@renderer/services/MessagesService'
import { appendMessageTrace, pauseTrace, restartTrace } from '@renderer/services/SpanManagerService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import store, { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import { addTopic } from '@renderer/store/assistants'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import {
  appendAssistantResponseThunk,
  clearTopicMessagesThunk,
  loadTopicMessagesThunk,
  regenerateAssistantResponseThunk,
  removeBlocksThunk,
  resendMessageThunk,
  resendUserMessageWithEditThunk,
  sendMessage as sendMessageThunk,
  updateMessageAndBlocksThunk
} from '@renderer/store/thunk/messageThunk'
import { type Assistant, type Model, type Topic, TopicType } from '@renderer/types'
import { objectKeys } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType } from '@renderer/types/newMessage'
import { abortCompletion } from '@renderer/utils/abortController'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { requestTopicSwitch } from '@renderer/utils/topicBranch'
import { difference } from 'lodash'
import { useCallback } from 'react'

const logger = loggerService.withContext('UseMessageOperations')

const selectMessagesState = (state: RootState) => state.messages

export const selectNewTopicLoading = createSelector(
  [selectMessagesState, (_, topicId: string) => topicId],
  (messagesState, topicId) => messagesState.loadingByTopic[topicId] || false
)

export const selectNewDisplayCount = createSelector(
  [selectMessagesState],
  (messagesState) => messagesState.displayCount
)

/**
 * Hook 提供针对特定主题的消息操作方法。 / Hook providing various operations for messages within a specific topic.
 * @param topic 当前主题对象。 / The current topic object.
 * @returns 包含消息操作函数的对象。 / An object containing message operation functions.
 */
export function useMessageOperations(topic: Topic) {
  const dispatch = useAppDispatch()

  /**
   * 分支重发核心：把（编辑后）的文本作为一次重发，在内核把当前会话按锚点 fork 成子分支
   * （源会话原样保留），随后把文本发进子分支并切换视图到子分支。
   * 返回是否成功；失败（锚点不可解析/内核错误）时调用方回退旧逻辑。
   */
  const startBranchResend = useCallback(
    async (
      anchorMessage: Message,
      assistant: Assistant,
      text: string,
      kind: 'resend' | 'regenerate' = 'resend'
    ): Promise<boolean> => {
      const trimmed = (text ?? '').trim()
      if (trimmed.length === 0) {
        logger.warn('[branchResend] nothing to send')
        return false
      }
      const forked = await forkBranchToKernel(topic.id, anchorMessage)
      if (forked === null) return false

      const preview = trimmed.replace(/\s+/g, ' ').slice(0, 30)
      const childTopic: Topic = {
        id: forked.id,
        type: TopicType.Chat,
        assistantId: assistant.id,
        name: preview.length > 0 ? preview : topic.name || '新分支',
        createdAt: new Date(forked.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date(forked.updatedAt ?? Date.now()).toISOString(),
        messages: [],
        parentTopicId: topic.id,
        branchKind: kind
      }
      dispatch(addTopic({ assistantId: assistant.id, topic: childTopic }))

      const { message: userMessage, blocks } = getUserMessage({
        content: trimmed,
        assistant,
        topic: childTopic
      })

      // 关键顺序：先把子分支的完整日志（含与父分支共享的上文）从内核加载进 store，
      // 再发新文本 —— 否则 store 里先有 stub 会让 loadTopicMessagesThunk 短路，
      // 子分支视图将看不到该轮之上的历史。
      await dispatch(loadTopicMessagesThunk(childTopic.id, true))

      void dispatch(sendMessageThunk(userMessage, blocks ?? [], assistant, childTopic.id))
      requestTopicSwitch(childTopic)
      return true
    },
    [dispatch, topic]
  )

  // ---------------------------------------------------------------------------
  // [恢复标记] 消息级删除已临时禁用（按钮保留为 no-op，避免 UI 假删）。
  // 原实现（truncateDelete/deleteMessage/deleteGroupMessages 走内核截断/焦点回跳）
  // 已在 kernel/topics.ts 的 MARKER 处拆除。装回时在此恢复原逻辑并在
  // services.ts(ctx.topicTree.truncateAtTurn)、kernel/index.ts(Dsh_TopicTruncate)、
  // preload 与 IpcChannel 复原。
  // ---------------------------------------------------------------------------
  const deleteMessage = useCallback(async (_id: string, _traceId?: string, _modelName?: string) => {
    logger.warn('[deleteMessage] message deletion is disabled (no-op)')
  }, [])

  const deleteGroupMessages = useCallback(async (_askId: string) => {
    logger.warn('[deleteGroupMessages] message deletion is disabled (no-op)')
  }, [])

  const editMessage = useCallback(
    async (messageId: string, updates: Partial<Omit<Message, 'id' | 'topicId' | 'blocks'>>) => {
      if (!topic?.id) {
        logger.error('[editMessage] Topic prop is not valid.')
        return
      }
      const uiStates = ['multiModelMessageStyle', 'foldSelected'] as const satisfies (keyof Message)[]
      const extraUpdate = difference(objectKeys(updates), uiStates)
      const isUiUpdateOnly = extraUpdate.length === 0
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: isUiUpdateOnly ? undefined : new Date().toISOString(),
        ...updates
      }

      // Call the thunk with topic.id and only message updates
      await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, []))
    },
    [dispatch, topic.id]
  )

  /**
   * 重新发送用户消息，触发其所有助手回复的重新生成。 / Resends a user message, triggering regeneration of all its assistant responses.
   * Dispatches resendMessageThunk.
   */
  const resendMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      await restartTrace(message)
      const entity = store.getState().messages.entities[message.id] ?? message
      const text = getMainTextContent(entity)
      if (text.trim().length === 0) {
        logger.warn('[resendMessage] message has no text content, skip')
        return
      }
      const ok = await startBranchResend(entity, assistant, text)
      if (!ok) {
        // 锚点不可解析（例如刚发送、回执未到）时回退旧逻辑
        await dispatch(resendMessageThunk(topic.id, entity, assistant))
      }
    },
    [dispatch, startBranchResend, topic.id]
  )

  /**
   * 清除当前或指定主题的所有消息。 / Clears all messages for the current or specified topic.
   * Dispatches clearTopicMessagesThunk.
   */
  const clearTopicMessages = useCallback(
    async (_topicId?: string) => {
      const topicIdToClear = _topicId || topic.id
      await dispatch(clearTopicMessagesThunk(topicIdToClear))
    },
    [dispatch, topic.id]
  )

  /**
   * 发出事件以表示创建新上下文（清空消息 UI）。 / Emits an event to signal creating a new context (clearing messages UI).
   */
  const createNewContext = useCallback(async () => {
    void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [])

  const displayCount = useAppSelector(selectNewDisplayCount)

  /**
   * 暂停当前主题正在进行的消息生成。 / Pauses ongoing message generation for the current topic.
   */
  const pauseMessages = useCallback(async () => {
    const state = store.getState()
    const topicMessages = selectMessagesForTopic(state, topic.id)
    if (!topicMessages) return

    const streamingMessages = topicMessages.filter((m) => m.status === 'processing' || m.status === 'pending')
    const askIds = [...new Set(streamingMessages?.map((m) => m.askId).filter((id) => !!id) as string[])]

    for (const askId of askIds) {
      abortCompletion(askId)
    }
    void pauseTrace(topic.id)
    dispatch(newMessagesActions.setTopicLoading({ topicId: topic.id, loading: false }))
  }, [topic.id, dispatch])

  /**
   * 恢复/重发用户消息（目前复用 resendMessage 逻辑）。 / Resumes/Resends a user message (currently reuses resendMessage logic).
   */
  const resumeMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      return resendMessage(message, assistant)
    },
    [resendMessage]
  )

  /**
   * 重新生成指定的助手消息回复。 / Regenerates a specific assistant message response.
   * Dispatches regenerateAssistantResponseThunk.
   */
  const regenerateAssistantMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      await restartTrace(message)
      if (message.role !== 'assistant') {
        logger.warn('regenerateAssistantMessage should only be called for assistant messages.')
        return
      }
      const state = store.getState()
      const anchor =
        (message.askId && state.messages.entities[message.askId]) ||
        (message.askId ? selectMessagesForTopic(state, topic.id).find((m) => m.id === message.askId) : undefined)
      if (anchor === undefined || anchor.role !== 'user') {
        await dispatch(regenerateAssistantResponseThunk(topic.id, message, assistant))
        return
      }
      const text = getMainTextContent(anchor)
      if (text.trim().length === 0) {
        logger.warn('[regenerateAssistantMessage] anchor has no text content, skip')
        return
      }
      const ok = await startBranchResend(anchor, assistant, text, 'regenerate')
      if (!ok) {
        await dispatch(regenerateAssistantResponseThunk(topic.id, message, assistant))
      }
    },
    [dispatch, startBranchResend, topic.id]
  )

  /**
   * 使用指定模型追加一个新的助手回复，回复与现有助手消息相同的用户查询。 / Appends a new assistant response using a specified model, replying to the same user query as an existing assistant message.
   * Dispatches appendAssistantResponseThunk.
   */
  const appendAssistantResponse = useCallback(
    async (existingAssistantMessage: Message, newModel: Model, assistant: Assistant) => {
      await appendMessageTrace(existingAssistantMessage, newModel)
      if (existingAssistantMessage.role !== 'assistant') {
        logger.error('appendAssistantResponse should only be called for an existing assistant message.')
        return
      }
      if (!existingAssistantMessage.askId) {
        logger.error('Cannot append response: The existing assistant message is missing its askId.')
        return
      }
      await dispatch(
        appendAssistantResponseThunk(
          topic.id,
          existingAssistantMessage.id,
          newModel,
          assistant,
          existingAssistantMessage.traceId
        )
      )
    },
    [dispatch, topic.id]
  )

  /**
   * Updates message blocks by comparing original and edited blocks.
   * Handles adding, updating, and removing blocks in a single operation.
   * @param messageId The ID of the message to update
   * @param editedBlocks The complete set of blocks after editing
   */
  const editMessageBlocks = useCallback(
    async (messageId: string, editedBlocks: MessageBlock[]) => {
      if (!topic?.id) {
        logger.error('[editMessageBlocks] Topic prop is not valid.')
        return
      }

      try {
        // 1. Get the current state of the message and its blocks
        const state = store.getState()
        const message = state.messages.entities[messageId]
        if (!message) {
          logger.error(`[editMessageBlocks] Message not found: ${messageId}`)
          return
        }

        // 2. Get all original blocks
        const originalBlocks = message.blocks
          ? message.blocks
              .map((blockId) => state.messageBlocks.entities[blockId])
              .filter((block) => block !== undefined)
          : []

        // 3. Create sets for efficient comparison
        const originalBlockIds = new Set(originalBlocks.map((block) => block.id))
        const editedBlockIds = new Set(editedBlocks.map((block) => block.id))

        // 4. Identify blocks to remove, update, and add
        const blockIdsToRemove = originalBlocks
          .filter((block) => !editedBlockIds.has(block.id))
          .map((block) => block.id)

        const blocksToUpdate = editedBlocks
          .filter((block) => originalBlockIds.has(block.id))
          .map((block) => ({
            ...block,
            updatedAt: new Date().toISOString()
          }))

        const blocksToAdd = editedBlocks
          .filter((block) => !originalBlockIds.has(block.id))
          .map((block) => ({
            ...block,
            updatedAt: new Date().toISOString()
          }))

        // 5. Prepare message update with new block IDs
        const updatedBlockIds = editedBlocks.map((block) => block.id)
        const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
          id: messageId,
          updatedAt: new Date().toISOString(),
          blocks: updatedBlockIds
        }

        // 6. Log operations for debugging
        // console.log('[editMessageBlocks] Operations:', {
        //   blocksToRemove: blockIdsToRemove.length,
        //   blocksToUpdate: blocksToUpdate.length,
        //   blocksToAdd: blocksToAdd.length
        // })

        // 7. Update Redux state and database
        // First update message and add/update blocks
        if (blocksToAdd.length > 0) {
          await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, blocksToAdd))
        }

        if (blocksToUpdate.length > 0) {
          await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, blocksToUpdate))
        }

        // Then remove blocks if needed
        if (blockIdsToRemove.length > 0) {
          await dispatch(removeBlocksThunk(topic.id, messageId, blockIdsToRemove))
        }
      } catch (error) {
        logger.error('[editMessageBlocks] Failed to update message blocks:', error as Error)
      }
    },
    [dispatch, topic?.id]
  )

  /**
   * 在用户消息的主文本块被编辑后重新发送该消息。 / Resends a user message after its main text block has been edited.
   * Dispatches resendUserMessageWithEditThunk.
   */
  const resendUserMessageWithEdit = useCallback(
    async (message: Message, editedBlocks: MessageBlock[], assistant: Assistant) => {
      await editMessageBlocks(message.id, editedBlocks)

      const mainTextBlock = editedBlocks.find((block) => block.type === MessageBlockType.MAIN_TEXT)
      if (!mainTextBlock || mainTextBlock.content.trim().length === 0) {
        logger.warn('[resendUserMessageWithEdit] no main text content, skip')
        return
      }

      await restartTrace(message, mainTextBlock.content)

      const fileBlocks = editedBlocks.filter(
        (block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE
      )

      const files = fileBlocks.map((block) => block.file).filter((file) => file !== undefined)

      const usage = await estimateUserPromptUsage({ content: mainTextBlock.content, files })
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: message.id,
        updatedAt: new Date().toISOString(),
        usage
      }

      dispatch(newMessagesActions.updateMessage({ topicId: topic.id, messageId: message.id, updates: messageUpdates }))
      const ok = await startBranchResend(message, assistant, mainTextBlock.content)
      if (!ok) {
        // 锚点不可解析时回退旧逻辑（原地重置并重发）
        await dispatch(resendUserMessageWithEditThunk(topic.id, message, assistant))
      }
    },
    [dispatch, editMessageBlocks, startBranchResend, topic.id]
  )

  /**
   * Removes a specific block from a message.
   */
  const removeMessageBlock = useCallback(
    async (messageId: string, blockIdToRemove: string) => {
      if (!topic?.id) {
        logger.error('[removeMessageBlock] Topic prop is not valid.')
        return
      }

      const state = store.getState()
      const message = state.messages.entities[messageId]
      if (!message || !message.blocks) {
        logger.error(`[removeMessageBlock] Message not found or has no blocks: ${messageId}`)
        return
      }

      const updatedBlocks = message.blocks.filter((blockId) => blockId !== blockIdToRemove)

      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: new Date().toISOString(),
        blocks: updatedBlocks
      }

      await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, []))
    },
    [dispatch, topic?.id]
  )

  return {
    displayCount,
    deleteMessage,
    deleteGroupMessages,
    editMessage,
    resendMessage,
    regenerateAssistantMessage,
    resendUserMessageWithEdit,
    appendAssistantResponse,
    createNewContext,
    clearTopicMessages,
    pauseMessages,
    resumeMessage,
    editMessageBlocks,
    removeMessageBlock
  }
}

export const useTopicMessages = (topicId: string) => {
  return useAppSelector((state) => selectMessagesForTopic(state, topicId))
}

export const useTopicLoading = (topic: Topic) => {
  return useAppSelector((state) => selectNewTopicLoading(state, topic.id))
}

/**
 * 当前话题是否"正在生成"（存在 PENDING/PROCESSING 的助手消息）。
 * 内核聊天的事件驱动流在 queue 排空后仍持续很久，loadingByTopic 会在 send 后很快被清掉，
 * 不能作为"生成中"的唯一信号 —— 暂停/停止按钮的可见性应以此信号为准。
 */
export const useTopicGenerating = (topic: Topic) => {
  return useAppSelector((state) => {
    const messageIds = state.messages.messageIdsByTopic[topic.id]
    if (messageIds === undefined || messageIds.length === 0) return false
    return messageIds.some((id) => {
      const message = state.messages.entities[id]
      return (
        message !== undefined &&
        message.role === 'assistant' &&
        (message.status === AssistantMessageStatus.PENDING || message.status === AssistantMessageStatus.PROCESSING)
      )
    })
  })
}
