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
// 若需装回消息删除：在此（sendMessage 之前）重新实现 truncateTopicAtTurn 等入口，
// 并在 services.ts（ctx.topicTree.truncateAtTurn）、kernel/index.ts（Dsh_TopicTruncate）、
// preload、渲染层恢复按钮回调。
// ---------------------------------------------------------------------------

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
