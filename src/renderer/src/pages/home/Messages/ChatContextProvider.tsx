import { useChatContext } from '@renderer/hooks/useChatContext'
import type { Topic } from '@renderer/types'
import { createContext, type FC, type ReactNode, use, useMemo } from 'react'

/**
 * 聊天页的窄上下文。
 *
 * `useChatContext(topic)` 此前在 Chat / Messages / MessageGroup / Message / MessageHeader /
 * MessageMenubar 各自实例化一份：N 条消息 = N+2 份同域状态 —— 每份都重建一套
 * `useMessageOperations`（21 个闭包）、各订阅 isMultiSelectMode/selectedMessageIds、
 * 各注册一个 CHANGE_TOPIC 监听、各写一次 `runtime.chat.activeTopic` 哨兵。
 * 现在只有本 Provider 调一次 hook，产物经 context 下发给消息区。
 */
export type ChatContextValue = ReturnType<typeof useChatContext>

const ChatContext = createContext<ChatContextValue | null>(null)

interface ChatContextProviderProps {
  topic: Topic
  children: ReactNode
}

export const ChatContextProvider: FC<ChatContextProviderProps> = ({ topic, children }) => {
  const {
    isMultiSelectMode,
    selectedMessageIds,
    toggleMultiSelectMode,
    handleMultiSelectAction,
    handleSelectMessage,
    activeTopic,
    locateMessage,
    messageRefs,
    registerMessageElement
  } = useChatContext(topic)

  // value 引用稳定化：字段里真正会变的只有多选态、选中集合与消息元素表；
  // 其余（回调、话题对象）在 Chat 的无关重渲染中保持同一引用，于是上下文不会被当成"更新"下发。
  const value = useMemo(
    () => ({
      isMultiSelectMode,
      selectedMessageIds,
      toggleMultiSelectMode,
      handleMultiSelectAction,
      handleSelectMessage,
      activeTopic,
      locateMessage,
      messageRefs,
      registerMessageElement
    }),
    [
      isMultiSelectMode,
      selectedMessageIds,
      toggleMultiSelectMode,
      handleMultiSelectAction,
      handleSelectMessage,
      activeTopic,
      locateMessage,
      messageRefs,
      registerMessageElement
    ]
  )

  return <ChatContext value={value}>{children}</ChatContext>
}

/** 读取聊天页上下文。缺少 Provider 时显式抛错：静默降级会把"多选态失效"变成不可见故障。 */
export const useChatContextValue = (): ChatContextValue => {
  const value = use(ChatContext)
  if (value === null) {
    throw new Error('useChatContextValue must be used inside ChatContextProvider')
  }
  return value
}
