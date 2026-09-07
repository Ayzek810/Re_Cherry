import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { loggerService } from '@logger'
import { KERNEL_REASONING_LEVELS, type KernelReasoningLevel } from '@shared/config/reasoning'
import { app } from 'electron'

const logger = loggerService.withContext('KernelTopics')

const REASONING_RANK = new Map<string, number>(KERNEL_REASONING_LEVELS.map((level, index) => [level, index]))

/** 话题元数据注册表（对话本体在 dsh session 里，这里只存 Cherry UI 需要的元数据）。 */
export interface KernelTopic {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  provider: string
  model: string
  maxTokens?: number
  systemPrompt?: string
  /** 当前请求使用的思考档位（pi-ai 词汇）；缺省/空串 = 不显式请求（交给 provider 默认）。 */
  reasoningEffort?: string
  /** 分支血缘：有值 = forkTopic 切出的子分支会话（父会话 id）；未定义 = 普通话题/窗口根。侧栏列表只显示根。 */
  parentTopicId?: string
  /** 截断删除后被取代：值为替代它的新会话 id；可见层与清扫只认新会话。 */
  supersededByTopicId?: string
}

export interface KernelTopicInput {
  id: string
  name?: string
  provider: string
  model: string
  maxTokens?: number
  systemPrompt?: string
  reasoningEffort?: string
}

interface TopicRegistryFile {
  topics: KernelTopic[]
}

let topics = new Map<string, KernelTopic>()
const liveHandles = new Map<string, AgentHandle>()

/**
 * provider/model → 该模型在 dsh/pi-ai 侧实际可用的思考档位（空数组 = 不支持思考控制）。
 * provider 路由重同步后调用 clearModelCapabilityCache 清空。
 */
const modelCapabilityCache = new Map<string, readonly string[] | undefined>()

function capabilityKey(provider: string, model: string): string {
  return provider + '\u0000' + model
}

/** provider 重同步后清空模型能力缓存，避免路由/目录变更后使用旧档位集。 */
export function clearModelCapabilityCache(): void {
  modelCapabilityCache.clear()
}

/** 查询模型可用思考档位；解析失败/无推理元数据时返回空数组（视为不支持思考控制）。 */
export async function supportedReasoningLevels(
  ctx: Context,
  provider: string,
  model: string
): Promise<readonly string[]> {
  const key = capabilityKey(provider, model)
  const cached = modelCapabilityCache.get(key)
  if (cached !== undefined || modelCapabilityCache.has(key)) return cached ?? []
  let supported: readonly string[]
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    supported = info.reasoning === undefined ? [] : info.reasoning.efforts.map((effort) => String(effort.id))
  } catch (error) {
    logger.warn(
      'kernel: failed to resolve reasoning capability for ' + provider + '/' + model + ', treating as unsupported',
      error instanceof Error ? error : new Error(String(error))
    )
    supported = []
  }
  modelCapabilityCache.set(key, supported)
  return supported
}

/**
 * 把请求档位收敛到模型实际支持的档位。
 * 返回 undefined = 不附加 reasoningEffort（走 provider 默认；无法关闭思考的模型视为“无法关闭”）。
 */
function pickReasoningLevel(requested: string, supported: readonly string[]): string | undefined {
  if (supported.includes(requested)) return requested
  if (supported.length === 0 || requested === 'off') return undefined
  // 就近收敛：与请求档位距离最近者；平手取更高档（如 deepseek 只支持 high/max 时 xhigh 收敛到 max）
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  const requestedRank = REASONING_RANK.get(requested) ?? -1
  for (const level of supported) {
    const rank = REASONING_RANK.get(level)
    if (rank === undefined) continue
    const distance = Math.abs(rank - requestedRank)
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && rank > (REASONING_RANK.get(best) ?? -1))
    ) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

/**
 * 非 agent 路径（一次性/流式 completion、冒烟等）直接发请求前，
 * 把请求档位解析为模型实际可用的内核档位；无请求/不合法/不支持时返回 undefined。
 */
export async function resolveRequestReasoningLevel(
  ctx: Context,
  provider: string,
  model: string,
  requested: string | undefined
): Promise<string | undefined> {
  if (requested === undefined || requested.length === 0) return undefined
  if (!KERNEL_REASONING_LEVELS.includes(requested as KernelReasoningLevel)) return undefined
  const supported = await supportedReasoningLevels(ctx, provider, model)
  return pickReasoningLevel(requested, supported)
}

/**
 * 在 agent 作用域上挂接思考档位注入：
 * 'agent/request' waterfall 每步运行，读取话题注册表中的当前档位并覆盖到请求配置上；
 * 无档位时移除继承自请求头的档位，恢复 provider 默认。
 * setup（create/resume 都执行）时挂接一次，随 agent ctx 销毁自动解挂。
 */
function attachReasoningEffortListener(agentCtx: Context, topicId: string): void {
  agentCtx.on(
    'agent/request',
    async (_payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> => {
      const config = await next()
      const topic = topics.get(topicId)
      const requested = topic?.reasoningEffort ?? ''
      if (requested.length === 0 || !KERNEL_REASONING_LEVELS.includes(requested as KernelReasoningLevel)) {
        const { reasoningEffort: _inherited, ...withoutEffort } = config
        return withoutEffort
      }
      const resolved = topic as KernelTopic
      const supported = await supportedReasoningLevels(agentCtx, resolved.provider, resolved.model)
      const level = pickReasoningLevel(requested, supported)
      if (level === undefined) {
        const { reasoningEffort: _inherited, ...withoutEffort } = config
        return withoutEffort
      }
      return { ...config, reasoningEffort: ReasoningEffortId(level) }
    }
  )
}

function registryPath(): string {
  return join(app.getPath('userData'), 'kernel', 'topics.json')
}

async function loadRegistry(): Promise<void> {
  try {
    const raw = await readFile(registryPath(), 'utf8')
    const parsed = JSON.parse(raw) as TopicRegistryFile
    if (Array.isArray(parsed.topics)) {
      // 旧 C 版遗留（rootId/parentId/parentAnchorUserSeq/titleFrozen）与现行血缘模型不兼容，
      // 加载时剔除，避免它们被当作根话题污染侧栏/分支枚举（会话数据仍在，仅注册表元数据不再引用）
      const legacy = parsed.topics.filter(
        (topic) =>
          (topic as { parentId?: string }).parentId !== undefined || (topic as { rootId?: string }).rootId !== undefined
      )
      if (legacy.length > 0) {
        logger.warn(`kernel: dropped ${legacy.length} legacy topic row(s) from registry (incompatible schema)`)
      }
      topics = new Map(
        parsed.topics
          .filter(
            (topic) =>
              (topic as { parentId?: string }).parentId === undefined &&
              (topic as { rootId?: string }).rootId === undefined
          )
          .map((topic) => [topic.id, topic] as const)
      )
    }
  } catch (error) {
    // 文件缺失或损坏：空注册表启动；损坏内容记日志，不覆盖原文件直到下次写入
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      logger.warn(
        'kernel: topic registry failed to load, starting empty',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }
}

async function persistRegistry(): Promise<void> {
  const file = registryPath()
  await mkdir(dirname(file), { recursive: true })
  const payload = JSON.stringify({ topics: [...topics.values()] }, null, 2)
  const temp = `${file}.tmp`
  await writeFile(temp, payload, 'utf8')
  await rename(temp, file)
}

/** 启动话题子系统：加载注册表并挂上 session 事件监听（标题回写）。 */
export async function initTopics(ctx: Context): Promise<void> {
  await loadRegistry()
  await sweepOrphanSessions(ctx)

  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title') {
      const topic = topics.get(session.id)
      if (topic !== undefined && typeof event.data.title === 'string') {
        topic.name = event.data.title
        topic.updatedAt = Date.now()
        void persistRegistry().catch((error) => {
          logger.warn('kernel: failed to persist topic title', error)
        })
      }
    }
  })

  logger.info(`kernel: topic registry ready (${topics.size} topics)`)
}

/** 会话列表（侧栏话题）：只显示根话题；fork 出的子分支不在此列出。按最近更新时间倒序。 */
export function listTopics(): KernelTopic[] {
  return [...topics.values()]
    .filter((topic) => topic.parentTopicId === undefined && topic.supersededByTopicId === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 某根话题下的全部分支（含根自身），广度优先顺序（根在前）。供分支图枚举。 */
export function listTopicBranches(rootTopicId: string): KernelTopic[] {
  const result: KernelTopic[] = []
  const queue: string[] = [rootTopicId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    const topic = topics.get(id)
    if (topic === undefined) continue
    if (topic.supersededByTopicId !== undefined) continue
    result.push(topic)
    for (const candidate of topics.values()) {
      if (candidate.parentTopicId === id) queue.push(candidate.id)
    }
  }
  return result
}

export function getTopic(id: string): KernelTopic | undefined {
  return topics.get(id)
}

/** 新建话题：注册表登记 + 建 agent/session。话题已存在时原地更新路由配置（保留 name/createdAt）。 */
export async function createTopic(ctx: Context, input: KernelTopicInput): Promise<KernelTopic> {
  const now = Date.now()
  const existing = topics.get(input.id)
  const topic: KernelTopic = {
    id: input.id,
    name: existing !== undefined && existing.name.length > 0 ? existing.name : (input.name ?? '新话题'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    provider: input.provider,
    model: input.model,
    ...(existing?.maxTokens !== undefined ? { maxTokens: existing.maxTokens } : {}),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(existing?.systemPrompt !== undefined && existing.systemPrompt.length > 0
      ? { systemPrompt: existing.systemPrompt }
      : {}),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(existing?.reasoningEffort !== undefined && existing.reasoningEffort.length > 0
      ? { reasoningEffort: existing.reasoningEffort }
      : {}),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    // upsert 保留分支血缘（fork 子会话在每次发送前会被 createTopic 幂等更新）
    ...(existing?.parentTopicId !== undefined ? { parentTopicId: existing.parentTopicId } : {})
  }
  topics.set(topic.id, topic)
  await ensureAgent(ctx, topic)
  await persistRegistry()
  logger.info(`kernel: topic "${topic.id}" ready (${topic.provider}/${topic.model})`)
  return topic
}

/** 更新话题运行时配置（目前仅思考档位），持久化注册表。 */
export async function updateTopicConfig(id: string, patch: { reasoningEffort?: string }): Promise<KernelTopic> {
  const topic = topics.get(id)
  if (topic === undefined) throw new Error(`kernel: topic "${id}" not found`)
  if (patch.reasoningEffort !== undefined) topic.reasoningEffort = patch.reasoningEffort
  topic.updatedAt = Date.now()
  await persistRegistry()
  return topic
}

/** 改名（用户显式重命名；自动标题回写走 session/event 监听）。 */
export async function renameTopic(id: string, name: string): Promise<KernelTopic> {
  const topic = topics.get(id)
  if (topic === undefined) throw new Error(`kernel: topic "${id}" not found`)
  topic.name = name
  topic.updatedAt = Date.now()
  await persistRegistry()
  return topic
}

/** 打开话题：确保 agent 已加载（未加载则从持久化恢复或新建）。 */
export async function openTopic(ctx: Context, id: string): Promise<Agent> {
  const topic = topics.get(id)
  if (topic === undefined) throw new Error(`kernel: topic "${id}" not found`)
  return ensureAgent(ctx, topic)
}

/**
 * fork 一条子分支（重发/重新生成/编辑重发的内核实现）：
 * 以锚点 user 消息所在轮之前为界，把前缀复制成一个新的子会话（同 provider/model/提示词/思考档位），
 * 源会话原样保留；调用方随后把（编辑后的）文本作为子会话首条新输入发出即可。
 * 返回子分支 KernelTopic（parentTopicId = 源话题 id，不进入 listTopics）。
 */
export async function forkTopic(
  ctx: Context,
  sourceTopicId: string,
  anchorUserMessageSeq: number
): Promise<KernelTopic> {
  const sourceTopic = topics.get(sourceTopicId)
  if (sourceTopic === undefined) throw new Error(`kernel: source topic "${sourceTopicId}" not found`)
  const sourceAgent = await openTopic(ctx, sourceTopicId)
  const events = sourceAgent.session.events as readonly SessionEvent[]

  const anchorIndex = events.findIndex((event) => event.type === 'user/message' && event.seq === anchorUserMessageSeq)
  if (anchorIndex === -1) {
    throw new Error(`kernel: user message seq ${anchorUserMessageSeq} not found in "${sourceTopicId}"`)
  }

  // 定位锚点消息所在轮 turn/start：seed 截到该轮之前（该轮及其后的旧走向不进子会话）
  let turnStartIndex = -1
  for (let index = anchorIndex; index >= 0; index -= 1) {
    if (events[index].type === 'turn/start') {
      turnStartIndex = index
      break
    }
  }
  if (turnStartIndex === -1) {
    throw new Error(`kernel: cannot locate turn start for seq ${anchorUserMessageSeq}`)
  }
  const seed = turnStartIndex === 0 ? [] : events.slice(0, turnStartIndex)

  const child: KernelTopic = {
    id: randomUUID(),
    name: sourceTopic.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: sourceTopic.provider,
    model: sourceTopic.model,
    ...(sourceTopic.maxTokens === undefined ? {} : { maxTokens: sourceTopic.maxTokens }),
    ...(sourceTopic.systemPrompt === undefined || sourceTopic.systemPrompt.length === 0
      ? {}
      : { systemPrompt: sourceTopic.systemPrompt }),
    ...(sourceTopic.reasoningEffort === undefined || sourceTopic.reasoningEffort.length === 0
      ? {}
      : { reasoningEffort: sourceTopic.reasoningEffort }),
    parentTopicId: sourceTopic.id
  }
  topics.set(child.id, child)
  try {
    await ensureAgent(ctx, child, { seed, parentSessionId: sourceTopic.id })
  } catch (error) {
    topics.delete(child.id)
    throw error
  }
  await persistRegistry()
  logger.info(
    `kernel: forked child "${child.id}" from "${sourceTopicId}" at user seq ${anchorUserMessageSeq} (seed ${seed.length})`
  )
  return child
}

/** 删除话题：销毁 agent + 物理清盘；其 fork 出的子分支一并递归删除。清盘统一经 ctx.sessionGC 服务。 */
export async function deleteTopic(ctx: Context, id: string): Promise<void> {
  await deleteTopicRecursive(ctx, id, new Set())
}

async function deleteTopicRecursive(ctx: Context, id: string, visited: Set<string>): Promise<void> {
  if (visited.has(id)) return
  visited.add(id)
  for (const child of [...topics.values()]) {
    if (child.parentTopicId === id) await deleteTopicRecursive(ctx, child.id, visited)
  }
  const handle = liveHandles.get(id)
  if (handle !== undefined) {
    await handle.dispose()
    liveHandles.delete(id)
  }
  topics.delete(id)
  await persistRegistry()
  await purgeViaSessionGC(ctx, id)
  logger.info(`kernel: topic "${id}" deleted`)
}

// ---------------------------------------------------------------------------
// [已移除/恢复标记] 消息级删除机制整套拆除（按钮已置为 no-op，见渲染层
// useMessageOperations.deleteMessage）。移除内容包括：truncateTopic /
// truncateTopicCascade / resolveTurnOwnerSession / seedBoundarySeq /
// sessionOwnUserCount / sessionContainsUserSeq / TurnTruncateResult /
// truncateTopicAtTurn / isProjectionPrefixOf·sessionProjection·blockText /
// anchorUserSeq(registry 字段) / deleteSessionOnly。
// 保留：整话题删除 deleteTopic → deleteTopicRecursive → ctx.sessionGC.purge（物理清盘）。
// v0.2.3 已用新引擎重装：destroyTurns（同轮 turn/start 起物理前缀截断），
// 替代 v1 的截断标记法；本段保留作 v1 机制的历史说明。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 消息级删除引擎（v0.2.3）。一次调用内完成受影响集合计算 + 物理执行 + 焦点推导
// ——内核权威，渲染层只传锚点（目标话题 + user seq），绝不自行算集合。
//
// 语义（version-report-v0.2.2.1 §2.7，引擎统一按下述派生）：
//   · 删轮 = 锚点创建会话从该轮 turn/start 起的后缀物理删除（保留会话 id，
//     与 forkTopic 的种子切片边界对称）；
//   · 血统上自被删轮分叉出的直接子分支（seed_length >= cutoff）整子树清盘；
//     分叉点更早（seed_length < cutoff）的子分支原样存活；
//   · 截断点前已无自有 user 轮（删的是该分支首个自有轮）→ 该分支整页清盘
//     （“删除最后一组问答对，双方删除并回退一级”），焦点按血统邻接：就近同级
//     （同 fork 接点、createdAt 就近）→ 无同级回父级 → 根删空为 null。
//
// 血统边界权威值 = sessions 表 seed_length（forkTopic 构造种子长度），
// 与渲染层从 end-seed 事件推导的 shared 同义，但取自内核持久层，不受投影影响。
// ---------------------------------------------------------------------------

export interface DestroyTurnsResult {
  /** 整题物理清盘的话题（含其全部后代子树）。 */
  purgedTopics: string[]
  /** 原地截断的话题（保留 id；事件 seq >= fromSeq 物理删除）。 */
  truncated: { id: string; fromSeq: number }[]
  /** 删除后 UI 焦点话题；null = 无可聚焦（整棵根话题被删空）。 */
  focusTopicId: string | null
}

/** 读若干会话的 seed_length（构造种子长度 = 血统边界）。行缺失/不可读记 null。 */
async function readSeedLengths(ids: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>()
  for (const id of ids) result.set(id, null)
  if (ids.length === 0) return result
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(app.getPath('userData'), 'kernel', 'sessions.db'))
    try {
      const stmt = db.prepare('SELECT seed_length FROM sessions WHERE id = ?')
      for (const id of ids) {
        const row = stmt.get(id) as { seed_length: number | null } | undefined
        if (row !== undefined) result.set(id, row.seed_length)
      }
    } finally {
      db.close()
    }
  } catch (error) {
    logger.warn(
      'kernel: failed to read session seed lengths',
      error instanceof Error ? error : new Error(String(error))
    )
  }
  return result
}

/** 种子长度不可得时拒绝整个删除请求（与“开轮会话拒绝”同一保守原则）。 */
function requireSeedLength(seedInfo: Map<string, number | null>, id: string): number {
  const value = seedInfo.get(id)
  if (value === null || value === undefined) {
    throw new Error(`kernel: session seed length for "${id}" unavailable, refusing deletion`)
  }
  return value
}

/** 注册表血统链（目标 → 根）；父指针悬空直接拒绝。 */
function topicLineage(targetId: string): KernelTopic[] {
  const chain: KernelTopic[] = []
  let cur = topics.get(targetId)
  if (cur === undefined) throw new Error(`kernel: topic "${targetId}" not found`)
  while (cur !== undefined) {
    chain.push(cur)
    if (cur.parentTopicId === undefined) break
    const parent = topics.get(cur.parentTopicId)
    if (parent === undefined) {
      throw new Error(`kernel: lineage of "${targetId}" broken at missing parent "${cur.parentTopicId}"`)
    }
    cur = parent
  }
  return chain
}

/** 只读递归收集子树话题 id。 */
function collectSubtree(rootId: string): string[] {
  const out: string[] = []
  const walk = (id: string): void => {
    out.push(id)
    for (const t of topics.values()) {
      if (t.parentTopicId === id) walk(t.id)
    }
  }
  walk(rootId)
  return out
}

/**
 * 会话物理截断：事务内 DELETE 后缀事件 + revision+1。
 * revision 契约：外部变更必须递增——协调器/准备缓存据其失效，否则再开 topic
 * 可能从截断前的缓存 Preparation 复活旧事件。语句与持久层插件自带资源
 * （delete-events-from.sql / update-session-revision.sql）逐字一致。
 */
async function truncateSessionEvents(id: string, cutoff: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(app.getPath('userData'), 'kernel', 'sessions.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(id, cutoff)
      db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(id)
      db.exec('COMMIT')
    } catch (txError) {
      db.exec('ROLLBACK')
      throw txError
    }
    // 真删加固：与整题清盘同款收尾，避免已删内容残留 WAL/文件页
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.exec('VACUUM')
    } catch (vacuumError) {
      logger.warn(
        'kernel: post-truncate checkpoint/vacuum skipped',
        vacuumError instanceof Error ? vacuumError : new Error(String(vacuumError))
      )
    }
  } finally {
    db.close()
  }
}

/** 焦点同级判定的中间结构。 */
interface SiblingEntry {
  t: KernelTopic
  seed: number | null | undefined
}

export async function destroyTurns(
  ctx: Context,
  targetTopicId: string,
  anchorUserSeqs: number[]
): Promise<DestroyTurnsResult> {
  // ---- 1. 入参校验（IPC 边界先拒绝畸形输入）----
  if (typeof targetTopicId !== 'string' || targetTopicId.length === 0) {
    throw new Error('kernel: destroyTurns requires a topic id')
  }
  if (!Array.isArray(anchorUserSeqs)) {
    throw new Error('kernel: destroyTurns requires an anchor user seq array')
  }
  const anchors = [...new Set(anchorUserSeqs)]
    .filter((seq) => Number.isInteger(seq) && seq >= 0)
    .sort((a, b) => a - b)
  if (anchors.length === 0) {
    throw new Error('kernel: destroyTurns requires at least one anchor user seq')
  }

  // ---- 2. 所有权解析：沿血统链上溯，首个种子边界 <= 锚点的会话即创建会话 ----
  //       （种子行 [0, seed_length) = 复制来的祖先内容；其后 = 本会话自有事件。
  //         多锚点必须同主；跨分支多选不支持，整批拒绝。）
  const lineage = topicLineage(targetTopicId)
  const lineageSeeds = await readSeedLengths(lineage.map((t) => t.id))
  const ownerCandidates = new Map<string, KernelTopic>()
  for (const anchor of anchors) {
    let owner: KernelTopic | undefined
    for (const t of lineage) {
      if (requireSeedLength(lineageSeeds, t.id) <= anchor) {
        owner = t
        break
      }
    }
    if (owner === undefined) {
      throw new Error(`kernel: anchor seq ${anchor} resolves to no session in lineage of "${targetTopicId}"`)
    }
    ownerCandidates.set(owner.id, owner)
  }
  if (ownerCandidates.size !== 1) {
    throw new Error('kernel: anchors span multiple sessions; cross-branch multi-select is not supported')
  }
  const owner = ownerCandidates.values().next().value as KernelTopic
  const ownerSeed = requireSeedLength(lineageSeeds, owner.id)

  // ---- 3. 活体日志对账：每个锚点必须是 owner 当前日志里的自有 user/message ----
  //       （日志若已被更早的删除截短，旧 seq 消失 → 视图过期，拒绝，待渲染层刷新重试。）
  const agent = await openTopic(ctx, owner.id)
  const events = agent.session.events as readonly SessionEvent[]
  const cutoffs: number[] = []
  for (const anchor of anchors) {
    const anchorIndex = events.findIndex((event) => event.type === 'user/message' && event.seq === anchor)
    if (anchorIndex === -1) {
      throw new Error(`kernel: anchor user seq ${anchor} not found in "${owner.id}" (stale view, refresh first)`)
    }
    let turnStartSeq = -1
    for (let index = anchorIndex; index >= 0; index -= 1) {
      if (events[index].type === 'turn/start') {
        turnStartSeq = events[index].seq
        break
      }
    }
    if (turnStartSeq === -1 || turnStartSeq <= ownerSeed) {
      throw new Error(`kernel: cannot locate own turn start for anchor seq ${anchor} in "${owner.id}"`)
    }
    cutoffs.push(turnStartSeq)
  }
  const cutoff = Math.min(...cutoffs)

  // ---- 4. 空壳测试：截断点前是否还有自有 user 轮 ----
  const keepsOwnTurn = events.some(
    (event) => event.type === 'user/message' && event.seq > ownerSeed && event.seq < cutoff
  )

  // ---- 5. 血缘关联读数：owner 直接子分支（后代规则）+ 父的子分支（焦点同级判定）----
  const directChildren = [...topics.values()].filter((t) => t.parentTopicId === owner.id && t.id !== owner.id)
  const parentRow = owner.parentTopicId === undefined ? undefined : topics.get(owner.parentTopicId)
  const siblingCandidates =
    parentRow === undefined
      ? []
      : [...topics.values()].filter((t) => t.parentTopicId === parentRow.id && t.id !== owner.id)
  const relationSeeds = await readSeedLengths([...directChildren, ...siblingCandidates].map((t) => t.id))
  const seedOf = (id: string): number => requireSeedLength(relationSeeds, id)

  // 后代规则（保留 id 时才需判定；整树清盘时全体随葬）：
  // 直接子分支 seed_length >= cutoff → 整子树清盘；< cutoff → 分叉点在存活前缀，原样不动。
  const doomedChildren = keepsOwnTurn ? directChildren.filter((t) => seedOf(t.id) >= cutoff) : []

  // ---- 6. 开轮守卫：owner 与全部待清盘子树在跑即整批拒绝 ----
  const guardIds = keepsOwnTurn ? [owner.id, ...doomedChildren.map((t) => t.id)] : collectSubtree(owner.id)
  for (const id of guardIds) {
    if (isTopicRunning(ctx, id)) {
      throw new Error(`kernel: session "${id}" is running, refusing deletion`)
    }
  }

  // ---- 7. 执行（集合先行快照，再动刀）----
  let purgedTopics: string[]
  let truncated: { id: string; fromSeq: number }[]
  let focusTopicId: string | null

  if (!keepsOwnTurn) {
    purgedTopics = collectSubtree(owner.id)
    await deleteTopicRecursive(ctx, owner.id, new Set())
    // 焦点血统邻接：同接点（seed_length 同值）存活同级 createdAt 就近 → 无则父级
    const parentId = owner.parentTopicId ?? null
    if (parentId === null) {
      focusTopicId = null
    } else {
      const surviving: SiblingEntry[] = siblingCandidates
        .filter((t) => topics.has(t.id))
        .map((t) => ({ t, seed: relationSeeds.get(t.id) }))
        .filter((entry) => entry.seed === ownerSeed)
      surviving.sort((a, b) => a.t.createdAt - b.t.createdAt)
      let pick: SiblingEntry | undefined = surviving.find((entry) => entry.t.createdAt > owner.createdAt)
      if (pick === undefined && surviving.length > 0) {
        pick = surviving[surviving.length - 1] as SiblingEntry
      }
      focusTopicId = pick === undefined ? parentId : pick.t.id
    }
    truncated = []
  } else {
    purgedTopics = doomedChildren.flatMap((t) => collectSubtree(t.id))
    for (const child of doomedChildren) {
      await deleteTopicRecursive(ctx, child.id, new Set())
    }
    // 先卸活体句柄（排空批量落盘）再物理截断，杜绝截断后旧事件补写回来
    const handle = liveHandles.get(owner.id)
    if (handle !== undefined) {
      await handle.dispose()
      liveHandles.delete(owner.id)
    }
    await truncateSessionEvents(owner.id, cutoff)
    const row = topics.get(owner.id)
    if (row !== undefined) {
      row.updatedAt = Date.now()
      await persistRegistry()
    }
    truncated = [{ id: owner.id, fromSeq: cutoff }]
    focusTopicId = owner.id
  }

  // ---- 8. 删除后清扫（孤儿/悬空统一走既有 sweep，无定时器）----
  await sweepOrphanSessions(ctx)

  logger.info(
    `kernel: destroyTurns on "${targetTopicId}" anchors=[${anchors.join(',')}] -> owner="${owner.id}" cutoff=${cutoff} purged=${purgedTopics.length} focus=${focusTopicId ?? '(none)'}`
  )
  return { purgedTopics, truncated, focusTopicId }
}

export async function sendMessage(
  ctx: Context,
  id: string,
  text: string,
  options?: { reasoningEffort?: string }
): Promise<void> {
  const agent = await openTopic(ctx, id)
  const topic = topics.get(id)
  if (topic !== undefined) {
    if (options?.reasoningEffort !== undefined) topic.reasoningEffort = options.reasoningEffort
    topic.updatedAt = Date.now()
  }
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  })
  agent.send(message, 'next-turn', true)
}

/** 物理清盘统一经 ctx.sessionGC 服务（插件可接管）；服务缺失时退回默认实现。 */
async function purgeViaSessionGC(ctx: Context, id: string): Promise<void> {
  const gc = (ctx as unknown as { sessionGC?: { purge: (id: string) => Promise<void> } }).sessionGC
  if (gc?.purge !== undefined) {
    try {
      await gc.purge(id)
      return
    } catch (error) {
      logger.warn(
        'kernel: ctx.sessionGC.purge failed, falling back to default purge',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }
  await purgePersistedSession(id)
}

export async function purgePersistedSession(id: string): Promise<void> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(app.getPath('userData'), 'kernel', 'sessions.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('DELETE FROM events WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      // 真删加固：回收 WAL，尽力压缩主库文件，避免已删内容残留在文件页里被工具/字节搜索翻出
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        db.exec('VACUUM')
      } catch (vacuumError) {
        logger.warn(
          'kernel: post-purge checkpoint/vacuum skipped',
          vacuumError instanceof Error ? vacuumError : new Error(String(vacuumError))
        )
      }
    } finally {
      db.close()
    }
    logger.info(`kernel: purged persisted session "${id}"`)
  } catch (error) {
    logger.warn(
      `kernel: failed to purge persisted session "${id}"`,
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

async function sweepOrphanSessions(ctx: Context): Promise<void> {
  try {
    const headers = await ctx.sessionPersistence.list()
    const known = new Set(topics.keys())
    let removed = 0
    let registryDirty = false
    for (const header of headers) {
      if (!known.has(header.id)) {
        await purgeViaSessionGC(ctx, header.id)
        removed += 1
      } else {
        const topic = topics.get(header.id)
        if (topic !== undefined && topic.supersededByTopicId !== undefined) {
          topics.delete(header.id)
          registryDirty = true
          await purgeViaSessionGC(ctx, header.id)
          removed += 1
        }
      }
    }
    // 注册表里父已不存在的悬空分支（历史缺陷遗留）：不可达且占用磁盘，一并清除
    for (const topicRow of [...topics.values()]) {
      if (topicRow.parentTopicId !== undefined && !topics.has(topicRow.parentTopicId)) {
        topics.delete(topicRow.id)
        registryDirty = true
        await purgeViaSessionGC(ctx, topicRow.id)
        removed += 1
      }
    }
    if (registryDirty) await persistRegistry()
    if (removed > 0) logger.info(`kernel: purged ${removed} orphan persisted session(s)`)
  } catch (error) {
    logger.warn('kernel: orphan session sweep failed', error instanceof Error ? error : new Error(String(error)))
  }
}

export function clearLiveHandles(): void {
  liveHandles.clear()
}

/** 中止当前回合。 */
export function stopTopic(ctx: Context, id: string): void {
  const agent = ctx.agents.get(SessionId(id))
  if (agent === undefined) return
  agent.cancel({ kind: 'user' })
}

/** 当前回合是否在跑（供 UI 显示生成中状态）。 */
export function isTopicRunning(ctx: Context, id: string): boolean {
  return ctx.agents.get(SessionId(id))?.status === 'running'
}

/** 取会话事件日志（打开话题后的初始渲染用）。 */
export function sessionEvents(ctx: Context, id: string): readonly import('@deepseek-ai/dsh-session').SessionEvent[] {
  const agent = ctx.agents.get(SessionId(id))
  if (agent === undefined) throw new Error(`kernel: session "${id}" is not loaded`)
  return agent.session.events
}

/** 一条可搜索的消息投影。 */
export interface KernelSearchHit {
  topicId: string
  topicName: string
  seq: number
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}

/**
 * 全库搜索：遍历内核持久化的所有会话，投影 user/assistant 消息文本，
 * 返回包含全部关键词（AND，大小写不敏感）的消息。
 * 数据源是内核 SQLite（权威）；旧 Dexie 数据按既定政策不参与。
 */
export async function searchSessions(ctx: Context, terms: string[]): Promise<KernelSearchHit[]> {
  const normalized = terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0)
  if (normalized.length === 0) return []

  const headers = await ctx.sessionPersistence.list()
  const hits: KernelSearchHit[] = []

  for (const header of headers) {
    const topicName = getTopic(header.id)?.name ?? header.id
    let events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]
    try {
      const inspection = await ctx.sessionPersistence.inspect(header.id)
      events = inspection.events
    } catch (error) {
      logger.warn(
        `kernel: failed to inspect session "${header.id}" for search`,
        error instanceof Error ? error : new Error(String(error))
      )
      continue
    }

    for (const event of events) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      // user/message 的文本在 event.data.content，assistant/message 在 event.data.message.content
      const content = event.type === 'user/message' ? event.data.content : event.data.message.content
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text.length === 0) continue
      const lower = text.toLowerCase()
      if (normalized.every((term) => lower.includes(term))) {
        hits.push({
          topicId: header.id,
          topicName,
          seq: event.seq,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          text,
          createdAt: header.createdAt
        })
      }
    }
  }

  return hits
}

async function ensureAgent(
  ctx: Context,
  topic: KernelTopic,
  options?: { seed?: readonly SessionEvent[]; parentSessionId?: string }
): Promise<Agent> {
  const existing = liveHandles.get(topic.id)
  if (existing !== undefined) return existing.agent

  const sessionId = SessionId(topic.id)
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live

  const agentOptions = {
    provider: topic.provider,
    model: topic.model,
    ...(topic.maxTokens === undefined ? {} : { maxTokens: topic.maxTokens })
  }
  const setup = (agentCtx: Context): void => {
    if (topic.systemPrompt !== undefined && topic.systemPrompt.length > 0) {
      agentCtx.systemPrompt.section({
        name: 'cherry:assistant',
        order: 0,
        text: topic.systemPrompt
      })
    }
    attachReasoningEffortListener(agentCtx, topic.id)
  }

  let handle: AgentHandle
  if (options?.seed !== undefined) {
    // fork 出的新子会话：直接用前缀事件建会话（不尝试 resume）
    handle = await ctx.agents.create({
      sessionId,
      seed: options.seed as SessionEvent[],
      meta: {
        ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
        seedLength: options.seed.length
      },
      agentOptions,
      setup
    })
  } else {
    // 先尝试从持久化恢复（重启后的话题）；失败则新建空会话
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    } catch (error) {
      logger.warn(
        `kernel: resume session "${topic.id}" failed, creating fresh`,
        error instanceof Error ? error : new Error(String(error))
      )
      handle = await ctx.agents.create({ sessionId, agentOptions, setup })
    }
  }
  liveHandles.set(topic.id, handle)
  return handle.agent
}
