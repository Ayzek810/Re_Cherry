import { fetchTopicEvents } from '@renderer/services/kernelEventStream'
import { type CMFamily, loadFamily } from '@renderer/utils/conversationModel'

interface Entry {
  signature: string
  promise: Promise<CMFamily>
}

const cache = new Map<string, Entry>()

/** 唯一家族取数入口（结构层统一）：按根话题缓存；signature 变化才重取。 */
export function loadConversationTree(rootTopicId: string, signature: string): Promise<CMFamily> {
  const existing = cache.get(rootTopicId)
  if (existing && existing.signature === signature) return existing.promise
  const promise = loadFamily(rootTopicId, {
    listBranches: async (id) => {
      const { topics } = (await window.api.dshTopicBranches(id)) as {
        topics: Array<{ id: string; name?: string; parentTopicId?: string }>
      }
      return topics
    },
    sessionEvents: async (id) => {
      try {
        // UI 视界取数（唯一入口）：注入的插件源消息已在内核侧剔除
        return await fetchTopicEvents(id)
      } catch {
        return []
      }
    }
  })
  cache.set(rootTopicId, { signature, promise })
  return promise
}
