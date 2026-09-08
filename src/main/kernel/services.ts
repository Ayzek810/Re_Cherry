/**
 * App 层服务 seam（P5/契约第 2 节收敛点）。
 *
 * 把话题树血缘 / 会话回收(物理清盘) / 思考档位能力查询挂到 cordis ctx 上，
 * 供未来“工作模式”插件接管（插件可用 ctx.topicTree / ctx.sessionGC / ctx.reasoning 替换默认实现）。
 * 默认实现仍是 topics.ts 的业务函数 —— 这里只建立服务 seam 与可替换边界，不做行为迁移。
 */
import type { Context } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'

import {
  createTopic,
  deleteTopic,
  destroyTurns,
  forkTopic,
  getTopic,
  isTopicRunning,
  listTopicBranches,
  listTopics,
  openTopic,
  purgePersistedSession,
  renameTopic,
  resolveRequestReasoningLevel,
  sendMessage,
  sessionEvents,
  stopTopic,
  supportedReasoningLevels,
  updateTopicConfig
} from './topics'

const logger = loggerService.withContext('KernelAppServices')

/** ctx.topicTree 服务面（结构性操作唯一出口；插件可整体替换默认实现）。 */
export interface TopicTreeService {
  listRoots: () => import('./topics').KernelTopic[]
  listBranches: (rootTopicId: string) => import('./topics').KernelTopic[]
  get: (id: string) => import('./topics').KernelTopic | undefined
  create: (input: {
    id: string
    name?: string
    provider: string
    model: string
    maxTokens?: number
    systemPrompt?: string
    reasoningEffort?: string
  }) => Promise<import('./topics').KernelTopic>
  rename: (id: string, name: string) => Promise<import('./topics').KernelTopic>
  updateConfig: (id: string, patch: { reasoningEffort?: string }) => Promise<import('./topics').KernelTopic>
  open: (id: string) => Promise<import('@deepseek-ai/dsh-agent').Agent>
  delete: (id: string) => Promise<void>
  /** 消息级删除引擎：锚点集合计算 + 物理截断/清盘 + 焦点推导，一次事务内核权威。 */
  destroyTurns: (topicId: string, anchorUserSeqs: number[]) => Promise<import('./topics').DestroyTurnsResult>
  fork: (sourceTopicId: string, anchorUserMessageSeq: number) => Promise<import('./topics').KernelTopic>
  send: (id: string, text: string, reasoningEffort?: string) => Promise<void>
  stop: (id: string) => void
  isRunning: (id: string) => boolean
  events: (id: string) => readonly import('@deepseek-ai/dsh-session').SessionEvent[]
}

/** ctx.sessionGC 服务面（物理清盘；插件可接管）。 */
export interface SessionGCService {
  purge: (sessionId: string) => Promise<void>
}

/** ctx.reasoning 服务面（思考档位能力/收敛；独立配置插件可接管）。 */
export interface ReasoningService {
  supportedLevels: (provider: string, model: string) => Promise<readonly string[]>
  resolveRequest: (provider: string, model: string, requested: string | undefined) => Promise<string | undefined>
}

/** 挂接 ctx.* 服务 seam（幂等：重复调用只重挂指针并告警）。 */
export function registerAppServiceSeams(ctx: Context): void {
  const app = ctx as unknown as Record<string, unknown>

  if (app.topicTree !== undefined) {
    logger.warn('kernel: ctx.topicTree already registered, overriding (plugin takeover)')
  }
  const topicTreeService: TopicTreeService = {
    listRoots: () => listTopics(),
    listBranches: (rootTopicId: string) => listTopicBranches(rootTopicId),
    get: (id: string) => getTopic(id),
    create: (input: {
      id: string
      name?: string
      provider: string
      model: string
      maxTokens?: number
      systemPrompt?: string
      reasoningEffort?: string
    }) => createTopic(ctx, input),
    rename: (id: string, name: string) => renameTopic(id, name),
    updateConfig: (id: string, patch: { reasoningEffort?: string }) => updateTopicConfig(id, patch),
    open: (id: string) => openTopic(ctx, id),
    delete: (id: string) => deleteTopic(ctx, id),
    destroyTurns: (topicId: string, anchorUserSeqs: number[]) => destroyTurns(ctx, topicId, anchorUserSeqs),
    fork: (sourceTopicId: string, anchorUserMessageSeq: number) => forkTopic(ctx, sourceTopicId, anchorUserMessageSeq),
    send: (id: string, text: string, reasoningEffort?: string) => sendMessage(ctx, id, text, { reasoningEffort }),
    stop: (id: string) => stopTopic(ctx, id),
    isRunning: (id: string) => isTopicRunning(ctx, id),
    events: (id: string) => sessionEvents(ctx, id)
  }
  app.topicTree = topicTreeService

  if (app.sessionGC !== undefined) {
    logger.warn('kernel: ctx.sessionGC already registered, overriding (plugin takeover)')
  }
  const sessionGCService: SessionGCService = {
    purge: (sessionId: string) => purgePersistedSession(sessionId)
  }
  app.sessionGC = sessionGCService

  if (app.reasoning !== undefined) {
    logger.warn('kernel: ctx.reasoning already registered, overriding (plugin takeover)')
  }
  const reasoningService: ReasoningService = {
    supportedLevels: (provider: string, model: string) => supportedReasoningLevels(ctx, provider, model),
    resolveRequest: (provider: string, model: string, requested: string | undefined) =>
      resolveRequestReasoningLevel(ctx, provider, model, requested)
  }
  app.reasoning = reasoningService

  logger.info('kernel: app service seams ready (topicTree/sessionGC/reasoning)')
}
