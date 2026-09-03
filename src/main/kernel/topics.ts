import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { loggerService } from '@logger'
import { app } from 'electron'

const logger = loggerService.withContext('KernelTopics')

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
}

export interface KernelTopicInput {
  id: string
  name?: string
  provider: string
  model: string
  maxTokens?: number
  systemPrompt?: string
}

interface TopicRegistryFile {
  topics: KernelTopic[]
}

let topics = new Map<string, KernelTopic>()
const liveHandles = new Map<string, AgentHandle>()

function registryPath(): string {
  return join(app.getPath('userData'), 'kernel', 'topics.json')
}

async function loadRegistry(): Promise<void> {
  try {
    const raw = await readFile(registryPath(), 'utf8')
    const parsed = JSON.parse(raw) as TopicRegistryFile
    if (Array.isArray(parsed.topics)) {
      topics = new Map(parsed.topics.map((topic) => [topic.id, topic]))
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

export function listTopics(): KernelTopic[] {
  return [...topics.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getTopic(id: string): KernelTopic | undefined {
  return topics.get(id)
}

/** 新建话题：注册表登记 + 建 agent/session。 */
export async function createTopic(ctx: Context, input: KernelTopicInput): Promise<KernelTopic> {
  const now = Date.now()
  const topic: KernelTopic = {
    id: input.id,
    name: input.name ?? '新话题',
    createdAt: now,
    updatedAt: now,
    provider: input.provider,
    model: input.model,
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt })
  }
  topics.set(topic.id, topic)
  await ensureAgent(ctx, topic)
  await persistRegistry()
  logger.info(`kernel: topic "${topic.id}" created (${topic.provider}/${topic.model})`)
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

/** 删除话题：销毁 agent（会话持久化数据按“旧数据不管”政策保留为孤儿）。 */
export async function deleteTopic(id: string): Promise<void> {
  const handle = liveHandles.get(id)
  if (handle !== undefined) {
    await handle.dispose()
    liveHandles.delete(id)
  }
  topics.delete(id)
  await persistRegistry()
  logger.info(`kernel: topic "${id}" deleted`)
}

/** 发送一条用户消息。 */
export async function sendMessage(ctx: Context, id: string, text: string): Promise<void> {
  const agent = await openTopic(ctx, id)
  const topic = topics.get(id)
  if (topic !== undefined) topic.updatedAt = Date.now()
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  })
  agent.send(message, 'next-turn', true)
}

/** 内核停止时调用：清空 live handle 引用（agent 本体由注册表 fiber 销毁负责）。 */
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

async function ensureAgent(ctx: Context, topic: KernelTopic): Promise<Agent> {
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
  }

  // 先尝试从持久化恢复（重启后的话题）；失败则新建
  let handle: AgentHandle
  try {
    handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
  } catch (error) {
    logger.warn(
      `kernel: resume session "${topic.id}" failed, creating fresh`,
      error instanceof Error ? error : new Error(String(error))
    )
    handle = await ctx.agents.create({ sessionId, agentOptions, setup })
  }
  liveHandles.set(topic.id, handle)
  return handle.agent
}
