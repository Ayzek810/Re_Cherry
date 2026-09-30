/**
 * 追问队列泵（v0.4.7）。回合成功结束后把队首追问按正常发送路径发出；
 * 暂停态/空队列不泵。发送构建与 Inputbar.sendMessage 的纯文本路径同构
 * （getUserMessage + usage 估算 + sendMessageThunk），trace span 不另启
 * （队列发送是用户已提交消息的延迟重放，不是新的根交互）。
 *
 * 触发点：kernelChat turn/end（仅成功/自然结束；error/aborted 不泵——失败轮
 * 的语义是"当前回答有问题"，自动接着发追问只会火上浇油）。
 */
import { loggerService } from '@logger'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import store from '@renderer/store'
import { enqueueFollowup, removeFollowup, selectFollowupQueue } from '@renderer/store/followupQueue'
import { sendMessage } from '@renderer/store/thunk/messageThunk'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'

const logger = loggerService.withContext('FollowupQueue')

export async function pumpFollowupQueue(topicId: string): Promise<void> {
  const state = store.getState()
  const queue = selectFollowupQueue(state, topicId)
  if (queue.paused || queue.items.length === 0) return

  const next = queue.items[0]
  const { row, assistant } = findTopicOwner(topicId)
  if (row === undefined || assistant === undefined) {
    logger.warn(`followupQueue: topic ${topicId} has no owning row/assistant, dropping queued item`)
    store.dispatch(removeFollowup({ topicId, id: next.id }))
    return
  }

  // 限流命中 = 发不出去：退回队首原位等待（不发也不丢）。
  if (checkRateLimit(assistant)) {
    store.dispatch(removeFollowup({ topicId, id: next.id }))
    store.dispatch(enqueueFollowup({ topicId, text: next.text }))
    logger.warn('followupQueue: rate limited, re-queued head item')
    return
  }

  store.dispatch(removeFollowup({ topicId, id: next.id }))
  try {
    const baseUserMessage: MessageInputBaseParams = { assistant, topic: row, content: next.text }
    baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)
    const { message, blocks } = getUserMessage(baseUserMessage)
    void store.dispatch(sendMessage(message, blocks, assistant, topicId))
    logger.info(`followupQueue: pumped queued follow-up for topic ${topicId} (${queue.items.length - 1} left)`)
  } catch (error) {
    logger.error('followupQueue: failed to send queued follow-up:', error as Error)
  }
}

/** 跨助手找话题行与持有助手（topicNaming 的 findTopicRow 同款，附 assistant 整对象）。 */
function findTopicOwner(topicId: string) {
  for (const assistant of store.getState().assistants.assistants) {
    const row = (assistant.topics ?? []).find((topic) => topic.id === topicId)
    if (row !== undefined) return { row, assistant }
  }
  return { row: undefined, assistant: undefined }
}
