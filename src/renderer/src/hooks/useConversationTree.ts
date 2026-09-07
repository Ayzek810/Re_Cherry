import { useEffect, useState } from 'react'

import type { CMFamily } from '@renderer/utils/conversationModel'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'

export interface ConversationTreeState {
  family: CMFamily | null
  loading: boolean
}

/**
 * 唯一"对话树"数据源（结构层统一）：
 * 以根话题为单位从内核取家族；所有视图共享同一份缓存（见 conversationTreeCache），
 * 禁止各自再拉。刷新：signature（同源变化签名）变化即重取。
 */
export function useConversationTree(rootTopicId: string, refreshSignature: string): ConversationTreeState {
  const [family, setFamily] = useState<CMFamily | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    void loadConversationTree(rootTopicId, refreshSignature).then((loaded) => {
      if (active) {
        setFamily(loaded)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [rootTopicId, refreshSignature])

  return { family, loading }
}

export default useConversationTree
