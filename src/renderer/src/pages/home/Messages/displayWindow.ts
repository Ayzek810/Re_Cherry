import type { Message } from '@renderer/types/newMessage'

/** 显示窗口"选中顺序"缓存：键 = `${条数}|${displayCount}|${末条 id}`。 */
export interface DisplayOrderCache {
  key: string
  ids: string[]
}

export const EMPTY_DISPLAY_ORDER_CACHE: DisplayOrderCache = { key: '', ids: [] }

/**
 * 反向推导显示窗口（自最新一条往前取，user 按 id / assistant 按 askId 去重，窗口按 displayCount 计数）。
 *
 * 抽到本模块是为了可测：它是 O(全量) 的推导，而调用点每个流式 delta 都会重渲染。
 */
export const computeDisplayMessages = (messages: Message[], startIndex: number, displayCount: number): Message[] => {
  // 如果剩余消息数量小于 displayCount，直接返回所有剩余消息的倒序切片
  if (messages.length - startIndex <= displayCount) {
    const result: Message[] = []
    for (let i = messages.length - 1 - startIndex; i >= 0; i--) {
      result.push(messages[i])
    }
    return result
  }
  const userIdSet = new Set() // 用户消息 id 集合
  const assistantIdSet = new Set() // 助手消息 askId 集合
  const displayMessages: Message[] = []

  // 处理单条消息的函数
  const processMessage = (message: Message) => {
    if (!message) return

    const idSet = message.role === 'user' ? userIdSet : assistantIdSet
    const messageId = message.role === 'user' ? message.id : message.askId

    if (!idSet.has(messageId)) {
      idSet.add(messageId)
      displayMessages.push(message)
      return
    }
    // 如果是相同 askId 的助手消息，也要显示
    displayMessages.push(message)
  }

  // 直接在原数组上倒序遍历，跳过前 startIndex 个，避免全量拷贝和 reverse()
  for (let i = messages.length - 1 - startIndex; i >= 0 && userIdSet.size + assistantIdSet.size < displayCount; i--) {
    processMessage(messages[i])
  }

  return displayMessages
}

export const displayOrderKey = (messages: Message[], displayCount: number): string => {
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : ''
  return `${messages.length}|${displayCount}|${lastMessageId}`
}

/**
 * 只在"条数 / 窗口大小 / 末条 id"变化时重算窗口顺序；流式内容变化（同一末条换实体）复用上一次的 id 顺序。
 *
 * **必须同时校验缓存里的 id 在当前实体表里都还在**（`byId`）。只比 key 是不够的：回合开始时
 * 用户消息的 id 会从临时 id 重映射成内核 id（助手消息的 `askId` 同步跟着改），而"条数 / displayCount /
 * 末条 id"三者可以完全不变。那时缓存里的旧 id 已经查不到实体，`projectDisplayMessages` 会把它静默过滤掉——
 * 真机实证：**生成期间用户消息卡片整条消失，回合结束后又回来**。
 *
 * 注意：复用 id 顺序 ≠ 复用实体。调用点仍必须按 id 从最新的 messages 重新投影实体引用，
 * 否则 `MessageGroup` 的 memo 会拿到旧实体、流式文本冻结。
 */
export const resolveDisplayOrder = (
  cache: DisplayOrderCache,
  messages: Message[],
  displayCount: number,
  compute: (messages: Message[], startIndex: number, displayCount: number) => Message[] = computeDisplayMessages,
  byId?: Map<string, Message>
): DisplayOrderCache => {
  const key = displayOrderKey(messages, displayCount)
  const everyIdResolvable = byId === undefined || cache.ids.every((id) => byId.has(id))
  if (cache.key === key && everyIdResolvable) return cache
  return { key, ids: compute(messages, 0, displayCount).map((message) => message.id) }
}

/** 按 id 顺序从最新实体表投影：逐元素同一引用时返回旧数组（省掉一次全量重渲染）。 */
export const projectDisplayMessages = (previous: Message[], ids: string[], byId: Map<string, Message>): Message[] => {
  const next = ids.map((id) => byId.get(id)).filter((message): message is Message => message !== undefined)
  return previous.length === next.length && previous.every((message, index) => message === next[index])
    ? previous
    : next
}
