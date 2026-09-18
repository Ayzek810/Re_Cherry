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

/**
 * 沿 Redux 行链（parentTopicId）上溯到**家族根 id**（同步、无 IPC、无内核往返）。
 * 起查行必须在表内——不在则返回自身 id（只有 id、行又尚未物化时的无害降级）。
 *
 * 侧栏信号折叠（v0.3.1 第三轮）的唯一根解析器：重发/旁答的回合记账都发生在
 * fork 出的**子会话** id 上，而侧栏只渲染根行——两个域之间必须有一层统一的
 * 折叠，否则"子会话在生成/完成"永远照不亮根行（重发流灯全灭的真根因）。
 */
export function rootTopicIdOf(topicId: string, allTopics: Topic[]): string {
  const byId = new Map(allTopics.map((row) => [row.id, row]))
  let current = byId.get(topicId)
  if (current === undefined) return topicId
  const visited = new Set<string>()
  while (current.parentTopicId !== undefined && current.parentTopicId.length > 0 && !visited.has(current.id)) {
    visited.add(current.id)
    const parent = byId.get(current.parentTopicId)
    if (parent === undefined) break
    current = parent
  }
  return current.id
}

/**
 * 沿 parentTopicId 向上找到该话题所属的根话题（找不到就返回自身）。
 * 与 rootTopicIdOf 的分工：这里**行对象在手**——即使该行尚未进入清单
 * （新 fork 分支刚 addTopic、调用方闭包还是旧帧清单），也能从对象自身的
 * parentTopicId 起步上溯到根。
 */
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

/**
 * 家族行签名（页码条/旁答条的家族缓存失效口径）：只含**本话题所在家族**的行
 * （本地血缘迭代下溯，跨多层成立），稳定排序；含 updatedAt（结构/记忆变更）
 * 与 branchKind（合并判定变更）。
 *
 * 与"盖全助手清单"旧口径的区别：无关话题的任何变动（发送/删除/改名发生在别的
 * 话题上）都不再推翻本家族的缓存——否则每条无关 updatedAt 都触发一次全家族重取，
 * 页码条在"清空→重建"间闪烁（真机实证的"乱跳"形态之一）。
 */
export function familyRowSignature(allTopics: Topic[], topicId: string): string {
  const self = allTopics.find((row) => row.id === topicId)
  if (!self) return ''
  const root = rootTopicOf(self, allTopics)
  const ids = new Set<string>([root.id])
  // 迭代收敛：行的父在本集合 → 行属于家族（血缘链可能隔多层）
  let grew = true
  while (grew) {
    grew = false
    for (const row of allTopics) {
      if (ids.has(row.id) || !row.parentTopicId) continue
      if (ids.has(row.parentTopicId) && !ids.has(row.id)) {
        ids.add(row.id)
        grew = true
      }
    }
  }
  return allTopics
    .filter((row) => ids.has(row.id))
    .map((row) => row.id + ':' + row.updatedAt + ':' + (row.branchKind ?? ''))
    .sort()
    .join('|')
}

/**
 * branchKind 判定的**跨助手联合口径**：输入 = 全部助手的行（`selectAllTopics`），
 * 同 id 多份持有（历史污染副本）时**首个有值的 kind 获胜**——kindless 副本（例如
 * 旧跨助手物化误建的重复行）绝不遮蔽带 kind 的正主；两份都有值时以清单顺序首个为准
 * （kind 是建分支那一刻记下的事实，只写一次，现实中不会冲突）。
 *
 * 为什么分支图/页码条/旁答条必须同用这一份：三者的结构（regenerate 合并、parallel 隐藏）
 * 全由 kind 决定。此前分支图取"激活助手"那份、页码条取"first-holder"那份——同一家族
 * 的行分属不同助手时两边读到不同 kind → 图当新分支建节点、条按祖先合并 → 结构对不上。
 */
export function branchKindsOf(rows: Topic[]): Record<string, string | undefined> {
  const map: Record<string, string | undefined> = {}
  for (const row of rows) {
    if (map[row.id] === undefined) map[row.id] = row.branchKind
  }
  return map
}

/**
 * 沿内核血缘（dshTopicGet.parentTopicId）求某会话的家族根 id；失败返回 null。
 *
 * 每一跳都带启动窗口重试（{@link retryKernelQuery}）：主进程并行建窗口与启内核，重启后
 * 用户往往**立刻**点分支图/重发，单次 `dshTopicGet` 会在 handler 注册前失败一次——那与
 * "内核不认识"是两回事。确定性答案（含"内核明确回答无此行"）不重试。
 */
export async function kernelRootTopicId(topicId: string): Promise<string | null> {
  const seen = new Set<string>()
  let id = topicId
  while (!seen.has(id)) {
    seen.add(id)
    const answer = await retryKernelQuery<{ id: string; parentTopicId?: string } | null>(async () => {
      try {
        const { topic } = (await window.api.dshTopicGet(id)) as {
          topic?: { id: string; parentTopicId?: string }
        }
        return topic ?? null
      } catch (error) {
        logger.warn(
          `[topicBranch] failed to get kernel topic ${id}`,
          error instanceof Error ? error : new Error(String(error))
        )
        return undefined
      }
    })
    if (answer === null) return null
    if (!answer.parentTopicId || answer.parentTopicId.length === 0) return answer.id
    id = answer.parentTopicId
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
