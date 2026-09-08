import { type Topic, TopicType } from '@renderer/types'

/** 是否为根话题（普通话题，非 fork 分支）。 */
export function isRootTopic(topic: Topic): boolean {
  return topic.parentTopicId === undefined || topic.parentTopicId.length === 0
}

/** 只保留根话题（侧栏/管理列表/默认选择用）。 */
export function listRootTopics(topics: Topic[]): Topic[] {
  return topics.filter((topic) => isRootTopic(topic))
}

/** 沿 parentTopicId 向上找到该话题所属的根话题（找不到就返回自身）。 */
export function rootTopicOf(topic: Topic, allTopics: Topic[]): Topic {
  let current = topic
  const visited = new Set<string>()
  while (current.parentTopicId !== undefined && current.parentTopicId.length > 0 && !visited.has(current.id)) {
    visited.add(current.id)
    const parent = allTopics.find((candidate) => candidate.id === current.parentTopicId)
    if (parent === undefined) break
    current = parent
  }
  return current
}

/** 沿内核血缘（dshTopicGet.parentTopicId）求某会话的家族根 id；失败返回 null。 */
export async function kernelRootTopicId(topicId: string): Promise<string | null> {
  const seen = new Set<string>()
  let id = topicId
  while (!seen.has(id)) {
    seen.add(id)
    try {
      const { topic } = (await window.api.dshTopicGet(id)) as {
        topic?: { id: string; parentTopicId?: string }
      }
      if (!topic) return null
      if (!topic.parentTopicId || topic.parentTopicId.length === 0) return topic.id
      id = topic.parentTopicId
    } catch {
      return null
    }
  }
  return null
}

/** 切话题请求事件名（HomePage 监听后调用 setActiveTopic）。 */
export const TOPIC_SWITCH_REQUEST = 'rec:set-active-topic'

/** 请求切换到某个话题（含 fork 分支子话题）。 */
export function requestTopicSwitch(topic: Topic): void {
  window.dispatchEvent(new CustomEvent(TOPIC_SWITCH_REQUEST, { detail: topic }))
}

export interface KernelRowMaterialize {
  row: Topic
  /** true = 本次由内核补齐并应 dispatch(addTopic) 的新行；false = 本地已存在。 */
  created: boolean
}

/**
 * 确保某内核会话有可用的本地 Topic 行（整合分支图点击 / 删除焦点跳转两处重复逻辑）。
 * 已有行直接返回；否则从内核取记录补齐（parentTopicId 缺失时用 fallbackParentId）。
 */
export async function materializeKernelTopicRow(params: {
  sessionId: string
  assistantId: string
  allTopics: Topic[]
  fallbackParentId?: string
  fallbackName?: string
}): Promise<KernelRowMaterialize | null> {
  const { sessionId, assistantId, allTopics } = params
  const existing = allTopics.find((t) => t.id === sessionId)
  if (existing) return { row: existing, created: false }
  try {
    const { topic: kernelTopic } = (await window.api.dshTopicGet(sessionId)) as {
      topic?: { id: string; name?: string; parentTopicId?: string }
    }
    if (!kernelTopic) return null
    const parentTopicId = kernelTopic.parentTopicId ?? params.fallbackParentId
    return {
      row: {
        id: kernelTopic.id,
        type: TopicType.Chat,
        assistantId,
        name: kernelTopic.name || params.fallbackName || '新分支',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        ...(parentTopicId && parentTopicId.length > 0 ? { parentTopicId } : {})
      },
      created: true
    }
  } catch (error) {
    console.warn('[topicBranch] failed to materialize kernel topic row ' + sessionId, error)
    return null
  }
}

let kernelRootIdsCache: Promise<Set<string> | null> | null = null

/** 取内核当前确认存在的根话题 id 集合（空/失败返回 null 表示"未知"）。带缓存。 */
export function loadKernelTopicRootIds(): Promise<Set<string> | null> {
  if (kernelRootIdsCache) return kernelRootIdsCache
  kernelRootIdsCache = (async () => {
    try {
      const { topics } = (await window.api.dshTopicList()) as {
        topics?: Array<{ id: string }>
      }
      if (!topics) return null
      return new Set(topics.map((topic) => topic.id))
    } catch (error) {
      console.warn('[topicBranch] failed to list kernel topics', error)
      return null
    }
  })()
  return kernelRootIdsCache
}

/** 渲染进程启动时刻：早于此、且内核不认识的根话题视为历史遗留孤儿（隐藏）；其后新建的视为有效（显示）。 */
const BOOT_TIME = Date.now()

/** 侧栏可见性：内核确认存在 → 显示；内核未知但启动后新建（尚未首发的空话题）→ 显示；启动前遗留且内核未知 → 隐藏。 */
export function shouldShowTopicRow(topic: Topic, kernelRoots: Set<string> | null): boolean {
  if (kernelRoots === null) return true
  if (kernelRoots.has(topic.id)) return true
  return new Date(topic.updatedAt).getTime() >= BOOT_TIME
}

/** 话题增删（fork/截断取代）后使内核根集合缓存失效，下次查询重新拉取。 */
export function invalidateKernelTopicRootIds(): void {
  kernelRootIdsCache = null
}
