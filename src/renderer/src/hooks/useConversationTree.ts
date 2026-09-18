import { loggerService } from '@logger'
import type { CMFamily } from '@renderer/utils/conversationModel'
import { loadConversationTree } from '@renderer/utils/conversationTreeCache'
import { useEffect, useState } from 'react'

const logger = loggerService.withContext('useConversationTree')

export interface ConversationTreeState {
  family: CMFamily | null
  loading: boolean
  /** 本次取数是否失败（内核瞬时不可达且重试窗口内未恢复）。失败时 family 是旧值或 null。 */
  failed: boolean
}

/**
 * 唯一"对话树"数据源（结构层统一）：
 * 以根话题为单位从内核取家族；所有视图共享同一份缓存（见 conversationTreeCache），
 * 禁止各自再拉。刷新：signature（同源变化签名）变化即重取。
 *
 * 失败语义：取数失败时**绝不**把家族渲染成"少了分支的假树"（缓存层已保证失败
 * 不会被吞成空会话）。同根失败 → 保留上一次成功的家族（宁旧勿假）；换根失败
 * → family 置 null，由视图按失败态显式呈现，而不是伪装成"没有消息"。
 */
export function useConversationTree(rootTopicId: string, refreshSignature: string): ConversationTreeState {
  const [entry, setEntry] = useState<{ rootId: string; family: CMFamily | null }>({ rootId: '', family: null })
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    loadConversationTree(rootTopicId, refreshSignature)
      .then((loaded) => {
        if (active) setEntry({ rootId: rootTopicId, family: loaded })
      })
      .catch((error: unknown) => {
        if (!active) return
        logger.warn(
          'failed to load family of ' + rootTopicId,
          error instanceof Error ? error : new Error(String(error))
        )
        setFailed(true)
        setEntry((prev) => (prev.rootId === rootTopicId ? prev : { rootId: rootTopicId, family: null }))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [rootTopicId, refreshSignature])

  return { family: entry.family, loading, failed }
}

export default useConversationTree
