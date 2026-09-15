import { loggerService } from '@logger'
import { type Topic, TopicType } from '@renderer/types'

const logger = loggerService.withContext('topicBranch')

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

/**
 * 家族浏览记忆恢复：进话题时优先落在根话题行记着的"最后浏览分支"上。
 * 记忆缺失、指向的分支行已被删除、或记的就是根自己 → 返回根（自然容错）。
 */
export function recallLastViewedBranch(root: Topic, allTopics: Topic[]): Topic {
  if (root.lastViewedBranchId === undefined) return root
  return allTopics.find((topic) => topic.id === root.lastViewedBranchId) ?? root
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
      topic?: KernelTopicRow
    }
    if (!kernelTopic) return null
    const row = topicFromKernelRow(kernelTopic, assistantId, {
      fallbackParentId: params.fallbackParentId,
      fallbackName: params.fallbackName
    })
    return { row, created: true }
  } catch (error) {
    logger.warn(
      '[topicBranch] failed to materialize kernel topic row ' + sessionId,
      error instanceof Error ? error : new Error(String(error))
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// 话题成员资格：**内核是唯一权威**（v0.3.0-2 目标 B）
//
// 本版退役的做法是"渲染层用自己那份 persist 推断内核那份的可见性"（BOOT_TIME 时间戳启发式）——
// 那是 v0.3.0-1 在事件层刚消灭过的同一个反模式，只是换了轴。替代方案是：成员资格一律问内核
// （`dshTopicList`），渲染层只做字段合并与补齐。
// ---------------------------------------------------------------------------

/** 内核话题行（`dshTopicList` / `dshTopicGet` 的返回形状）。 */
export interface KernelTopicRow {
  id: string
  name: string
  /** 创建时间，**epoch ms**（内核口径；渲染层 `Topic` 用 ISO 串，换算只在 {@link topicFromKernelRow} 一处）。 */
  createdAt: number
  /** 最近更新时间，**epoch ms**（同上）。 */
  updatedAt: number
  parentTopicId?: string
}

/**
 * 用内核行构造渲染层 `Topic` 行——**唯一**的 ms → ISO 换算点。
 * @param row - 内核返回的话题行。
 * @param assistantId - 归属助手。
 * @param fallback - 内核行缺字段时的兜底（`parentTopicId` / `name`）。
 */
export function topicFromKernelRow(
  row: KernelTopicRow,
  assistantId: string,
  fallback?: { fallbackParentId?: string; fallbackName?: string }
): Topic {
  const parentTopicId = row.parentTopicId ?? fallback?.fallbackParentId
  return {
    id: row.id,
    type: TopicType.Chat,
    assistantId,
    name: row.name || fallback?.fallbackName || '新分支',
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    messages: [],
    ...(parentTopicId !== undefined && parentTopicId.length > 0 ? { parentTopicId } : {})
  }
}

/**
 * 上次会话留下的行（rehydrate 时登记一次，见 `store/index.ts`）。
 *
 * **为什么需要它**：新话题在**首次发送**前内核并不知道它（建册发生在 `ensureKernelTopic`），
 * 所以"内核不认识"这一个事实不足以判一行失效。判据必须是"这一行是上次会话留下来的"——
 * 一个**显式事件**（持久化恢复），而不是时间戳（`updatedAt >= BOOT_TIME` 正是本版退役的启发式，
 * 它既受时钟影响，又要跨 ms/ISO 两种口径比较）。
 */
let restoredTopicIds: ReadonlySet<string> = new Set()

/** 登记"从上次会话持久化恢复的行"。 */
export function noteRestoredTopicIds(ids: Iterable<string>): void {
  restoredTopicIds = new Set(ids)
  logger.info(`[topicBranch] recorded ${restoredTopicIds.size} restored topic row(s) from the previous session`)
}

/** 该行是否来自上次会话的持久化——只有这类行才可能"内核已遗忘"。 */
export function isRestoredTopicRow(id: string): boolean {
  return restoredTopicIds.has(id)
}

/** 上次取到的内核根话题（id → 行）；null = 尚未取到或上次取失败。 */
let kernelRoots: Map<string, KernelTopicRow> | null = null
let kernelRootsInFlight: Promise<Map<string, KernelTopicRow> | null> | null = null

async function fetchKernelRoots(): Promise<Map<string, KernelTopicRow> | null> {
  try {
    const { topics } = (await window.api.dshTopicList()) as { topics?: KernelTopicRow[] }
    if (!Array.isArray(topics)) return null
    return new Map(topics.map((row) => [row.id, row]))
  } catch (error) {
    logger.warn('[topicBranch] failed to list kernel topics', error instanceof Error ? error : new Error(String(error)))
    return null
  }
}

/**
 * 内核根话题集合（权威成员集合）。命中缓存即返回；对账入口用 {@link refreshKernelRootTopics} 强制取新。
 * @returns id → 内核行；`null` = **未知**——调用方此时必须退回渲染层现有行，绝不据此隐藏任何行。
 */
export async function kernelRootTopics(): Promise<Map<string, KernelTopicRow> | null> {
  if (kernelRoots !== null) return kernelRoots
  return await refreshKernelRootTopics()
}

/** 重新问内核并更新缓存（同一时刻只发一次 IPC）。 */
export async function refreshKernelRootTopics(): Promise<Map<string, KernelTopicRow> | null> {
  if (kernelRootsInFlight !== null) return kernelRootsInFlight
  kernelRootsInFlight = (async () => {
    const rows = await fetchKernelRoots()
    if (rows !== null) kernelRoots = rows
    return rows
  })()
  try {
    return await kernelRootsInFlight
  } finally {
    kernelRootsInFlight = null
  }
}

/** 建册/删除之后让缓存作废（下一次查询重新问内核）。 */
export function invalidateKernelRootTopics(): void {
  kernelRoots = null
}

/**
 * 内核查询的启动窗口重试参数。
 *
 * 为什么需要：主进程**并行**建窗口与启动内核（`src/main/index.ts`：`createMainWindow()` 之后才
 * `bootKernel()`），而 `dsh:*` 的 handler 要等 `initTopics()` 之后才注册——这期间渲染层查询会以
 * "No handler registered" 失败。那是**预期内的瞬时失败**，不是"内核未知"。
 * 两处内核查询（本模块的 {@link kernelKnowsTopic} 与 `services/kernelTopics.ts` 的对账入口）
 * **共用**这两个常量：同一竞态在两处给出不同处置曾是真实的维护隐患。
 */
export const KERNEL_QUERY_ATTEMPTS = 6
export const KERNEL_QUERY_DELAY_MS = 700

/**
 * 重试一个"可能因内核尚未就绪而失败"的查询。
 *
 * 语义要点：**延时只在失败之后发生**——成功路径不引入任何定时器（热路径零新增开销）；
 * 而"确定性答案"（哪怕是否定的）不再重试，重试一个已经明确的答案只会白白拖慢调用方。
 * @param query - 查询函数。返回 `undefined` = 本次没问到（可重试）；返回任何其它值（含 `false`、
 *   空集合）= **确定性答案**，立即返回。
 * @param options - 尝试次数与间隔（默认 {@link KERNEL_QUERY_ATTEMPTS} × {@link KERNEL_QUERY_DELAY_MS}）；仅供测试收窄。
 * @returns 查询答案；全部尝试都没问到 → `null`（"不知道"）。
 */
export async function retryKernelQuery<T>(
  query: () => Promise<T | undefined>,
  options?: { attempts?: number; delayMs?: number }
): Promise<T | null> {
  const attempts = options?.attempts ?? KERNEL_QUERY_ATTEMPTS
  const delayMs = options?.delayMs ?? KERNEL_QUERY_DELAY_MS
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await query()
    if (answer !== undefined) return answer
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}

/**
 * 内核注册表里是否有这一行。根话题用 `dshTopicList`（见 {@link kernelRootTopics}），
 * **fork 子行只能用这里**——`dshTopicList` 只返回根。
 *
 * 带启动窗口重试（与对账入口同口径，见 {@link retryKernelQuery}）：本查询服务于"拒绝复活"的判定
 * （`ensureKernelTopic` 用它决定是否允许 upsert），而在 handler 注册前它只会拿到
 * "No handler registered"——只试一次会把"暂时不知道"当成"知道"，于是 `dshTopicCreate` 会把一个
 * 内核已遗忘的 id **复活**（违反内核兼容契约第 4 节）。重试把该窗口收窄到与列表路径等价。
 *
 * **确定性否定不重试**：内核明确回答"无此行"（`topic === undefined`）时立即返回 `false`。
 * 本函数仍是 fail-open：「全部尝试都没问到」返回 `null`，调用方按"不知道"处理，
 * **不得**据此拒绝或隐藏任何东西。
 * @param id - 话题 id。
 * @param options - 仅用于测试：收窄重试次数与间隔。
 * @returns `true` / `false`；`null` = 全部尝试都没问到。
 */
export async function kernelKnowsTopic(
  id: string,
  options?: { attempts?: number; delayMs?: number }
): Promise<boolean | null> {
  const answer = await retryKernelQuery<boolean>(async () => {
    try {
      const { topic } = (await window.api.dshTopicGet(id)) as { topic?: KernelTopicRow }
      return topic !== undefined
    } catch (error) {
      logger.warn(
        `[topicBranch] failed to get kernel topic ${id}`,
        error instanceof Error ? error : new Error(String(error))
      )
      return undefined
    }
  }, options)
  if (answer === null) {
    logger.warn(
      `[topicBranch] kernel did not answer whether topic ${id} exists after ${
        options?.attempts ?? KERNEL_QUERY_ATTEMPTS
      } attempt(s)`
    )
  }
  return answer
}
