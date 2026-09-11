import { loadFamily, type CMFamily } from '@renderer/utils/conversationModel'

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
        const { events } = (await window.api.dshTopicEvents(id)) as {
          events: Array<{ seq: number; type: string; data?: unknown }>
        }
        return events
      } catch {
        return []
      }
    }
  })
  cache.set(rootTopicId, { signature, promise })
  return promise
}

