import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as fsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime, { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import * as piAiPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { registerSessionTitleLlmProvider } from '@deepseek-ai/dsh-session-title-llm'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { loggerService } from '@logger'
import { WORK_MODE_APPROVAL_TIERS } from '@shared/config/workMode'
import { IpcChannel } from '@shared/IpcChannel'
import type {
  KernelApprovalDecisionPayload,
  KernelQuestionAnswerPayload
} from '@shared/interaction/types'
import { app, BrowserWindow, ipcMain } from 'electron'

import { CherryCredentialProvider } from './credentials'
import { KernelInteractionHub, registerInteractionHost } from './interaction'
import { type KernelProviderInput, syncCherryProviders } from './providers'
import { registerAppServiceSeams, type TopicTreeService } from './services'
import { clearLiveHandles, getTopic, initTopics, listTopicBranches, listTopics, searchSessions } from './topics'

const logger = loggerService.withContext('Kernel')

/** ctx.topicTree 服务访问器（IPC 薄转发的唯一路径；服务在 boot 时由 registerAppServiceSeams 挂接）。 */
function topicTree(ctx: Context): TopicTreeService {
  const service = (ctx as unknown as { topicTree: TopicTreeService }).topicTree
  if (service === undefined) throw new Error('kernel: ctx.topicTree not registered')
  return service
}

/** ctx.reasoning 服务访问器（思考档位收敛；独立配置插件可接管）。 */
function reasoning(ctx: Context): {
  resolveRequest: (p: string, m: string, r?: string) => Promise<string | undefined>
} {
  const service = (
    ctx as unknown as {
      reasoning: { resolveRequest: (p: string, m: string, r?: string) => Promise<string | undefined> }
    }
  ).reasoning
  if (service === undefined) throw new Error('kernel: ctx.reasoning not registered')
  return service
}

let kernelContext: Context | undefined
let interactionHub: KernelInteractionHub | undefined

/** 已启动的内核上下文；未启动或已销毁时为 undefined。 */
export function getKernel(): Context | undefined {
  return kernelContext
}

/**
 * 停止内核：逆序 dispose 注册表中所有插件 fiber，
 * SQLite 持久化连接、事件监听等副作用随各自 disposer 清理。
 * 应用退出（will-quit）时必须调用，否则主进程事件循环被拖住、进程退不干净。
 */
export async function stopKernel(): Promise<void> {
  const ctx = kernelContext
  if (ctx === undefined) return
  kernelContext = undefined
  interactionHub?.disposeAll()
  interactionHub = undefined
  clearLiveHandles()

  const runtimes = [...ctx.registry.values()]
  for (const runtime of runtimes.reverse()) {
    for (const fiber of [...runtime.fibers]) {
      try {
        await fiber.dispose()
      } catch (error) {
        logger.warn(
          'dsh kernel: fiber dispose failed during shutdown',
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }
  }
  logger.info('dsh kernel stopped')
}

/**
 * 在主进程内以编程方式组装 Cordis 插件树（不走 YAML loader，避开打包路径问题）。
 * 插件树 = 内核：llm + 三协议适配器 + 会话存储/持久化 + 自动标题 + agent 回合循环。
 * 性能约束：无 HMR 文件监视、无定时器、无子进程、无 worker；写盘全部事件驱动。
 */
export async function bootKernel(): Promise<Context> {
  if (kernelContext !== undefined) return kernelContext

  const kernelDir = join(app.getPath('userData'), 'kernel')
  const ctx = new Context()

  try {
    // 配置与凭证层（provider 路由配置、apiKey 都由渲染进程推送）
    await ctx.plugin(FileSettingsProvider, {
      path: join(kernelDir, 'settings.json'),
      watch: false
    })
    await ctx.plugin(CherryCredentialProvider)

    // LLM 层
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(piAiPlugin, { providers: {} })

    // 提示词与工具层（tools 空注册：MCP 已砍，占位满足 agent-loop 的 inject）
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: ''
    })
    await ctx.plugin(ToolRuntime, { mode: 'native' })

    // 审批与问答（Step 2）：审批服务（ask 档 → answerer 链）+ 问答服务缝。
    // ask_user_question 工具改为 agent 作用域挂载（topics.ts，按助手"内置工具"开关，
    // 见 @shared/config/agentTools）——根部常驻会让纯对话请求永远携带工具 schema。
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(UserQuestionService)

    // 沙箱与文件系统（Step 3）：策略服务（部署默认 read-only；工作区回退根 = 数据文件夹下的 .agent 围栏
    // ——助手未设工作目录的会话以此为本，围栏外读写一律拒绝或走审批升级，不再放宽到用户主目录）
    // + 沙箱化 fs 后端 + 观察策略（edit 前必须先读）+ 子进程运行时（glob/grep 的 rg 通道）。
    // 工具本体在 agent setup 时按话题工作模式作用域挂载（topics.ts ensureAgent），关闭 = 纯对话。
    const agentWorkspaceRoot = join(app.getPath('userData'), '.agent')
    await mkdir(agentWorkspaceRoot, { recursive: true })
    await ctx.plugin(SandboxPolicyService, {
      mode: 'read-only',
      workspaceRoot: agentWorkspaceRoot
    })
    await ctx.plugin(SandboxedFileSystem, {})
    await ctx.plugin(fsObservationPolicy)
    await ctx.plugin(LocalSubprocessRuntime)

    // 命令行与后台作业（Step 4）：shell-env 环境注册表（DSH_* 托管变量）+ 沙箱 runner
    // + 沙箱化 pwsh 执行器（ctx.shell，按会话 sandbox/mode 收敛）+ 进程内作业注册表（ctx.jobs）。
    await ctx.plugin(shellEnv, { dshHome: join(kernelDir) })
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPwshExecutor, {})
    await ctx.plugin(LocalJobRegistry, {})

    // 会话层：内存 store + SQLite 持久化 + 自动标题
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionPersistence, {
      path: join(kernelDir, 'sessions.db')
    })
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 12,
      fallbackMaxBytes: 512,
      maxTitleBytes: 1024
    })
    // 话题自动命名：首次提问后用会话同一路由调一次 llm.stream
    registerSessionTitleLlmProvider(
      ctx,
      {
        targetWords: 6,
        targetCjkCharacters: 12,
        maxInputBytes: 8000,
        maxOutputTokens: 128,
        timeoutMs: 30_000
      },
      'cherry',
      'first-prompt',
      (messages) => messages
    )

    // Agent 层：注册表 + 回合循环（工厂由 loop 注入注册表）
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    // App 服务 seam（P5）：话题树/会话回收/思考档位查询挂到 ctx，供未来插件接管
    registerAppServiceSeams(ctx)

    await initTopics(ctx)
    registerEventForwarding(ctx)

    // 审批/问答往返：请求帧推给所有窗口，回执经 IPC 回来（未决请求随内核停机作废）
    interactionHub = registerInteractionHost(ctx, (message) => {
      const { kind, payload } = message as { kind: 'approval' | 'question'; payload: unknown }
      if (kind === 'approval') broadcast(IpcChannel.Dsh_ApprovalRequest, payload)
      else if (kind === 'question') broadcast(IpcChannel.Dsh_QuestionRequest, payload)
    })
    registerKernelIpc()

    kernelContext = ctx
    logger.info('dsh kernel booted')
    return ctx
  } catch (error) {
    logger.error('dsh kernel failed to boot', error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

/** 内核事件 → 所有窗口（UI 是内核的显示器）。 */
function registerEventForwarding(ctx: Context): void {
  ctx.on('session/event', (session, event) => {
    broadcast('dsh:session-event', { topicId: session.id, event })
  })
  ctx.on('session/created', (session) => {
    broadcast('dsh:session-event', { topicId: session.id, event: { type: 'session/created', data: {} } })
  })
  ctx.on('session/disposed', (session) => {
    broadcast('dsh:session-event', { topicId: session.id, event: { type: 'session/disposed', data: {} } })
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

/** 内核 IPC：provider 同步、冒烟、话题 CRUD 与聊天。 */
function registerKernelIpc(): void {
  const requireKernel = (): Context => {
    const ctx = getKernel()
    if (ctx === undefined) throw new Error('kernel not booted')
    return ctx
  }

  ipcMain.handle(IpcChannel.Dsh_SyncProviders, async (_event, providers: KernelProviderInput[]) => {
    await syncCherryProviders(requireKernel(), providers)
    return { ok: true }
  })

  ipcMain.handle(
    IpcChannel.Dsh_StreamSmoke,
    async (
      _event,
      payload: { providers: KernelProviderInput[]; providerId: string; modelId: string; prompt: string }
    ) => {
      const ctx = requireKernel()
      const { providers, providerId, modelId, prompt } = payload

      await syncCherryProviders(ctx, providers)

      const assembler = new BlockAssembler()
      const options = {
        provider: providerId,
        model: modelId,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'cherry-smoke' }
          })
        ]
      }
      for await (const chunk of ctx.llm.stream(options)) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(finish.failure.message)
      }
      const text = assembler
        .blocks()
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return { text, finish: finish.kind }
    }
  )

  // ---- 一次性 completion（话题命名/搜索编排/记忆/错误诊断/健康检查） ----

  ipcMain.handle(
    IpcChannel.Dsh_Complete,
    async (
      _event,
      payload: {
        provider: string
        model: string
        system?: string
        messages: { role: 'user' | 'assistant'; text: string }[]
        maxTokens?: number
        reasoningEffort?: string
      }
    ) => {
      const ctx = requireKernel()
      const { provider, model } = payload
      const reasoningEffort = await reasoning(ctx).resolveRequest(provider, model, payload.reasoningEffort)
      const assembler = new BlockAssembler()
      const options = {
        provider,
        model,
        messages: payload.messages.map((message) =>
          message.role === 'user'
            ? createUserMessage({
                content: [{ type: 'text', text: message.text }],
                source: { kind: 'plugin', plugin: 'cherry-complete' }
              })
            : createAssistantMessage({
                content: [{ type: 'text', text: message.text }],
                source: { provider, model }
              })
        ),
        ...(payload.system === undefined || payload.system.length === 0 ? {} : { system: payload.system }),
        ...(payload.maxTokens === undefined ? {} : { maxTokens: payload.maxTokens }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) })
      }
      for await (const chunk of ctx.llm.stream(options)) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(finish.failure.message)
      }
      const text = assembler
        .blocks()
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return {
        text,
        usage: assembler.usage
          ? {
              inputTokens: assembler.usage.inputTokens,
              outputTokens: assembler.usage.outputTokens
            }
          : undefined
      }
    }
  )

  // ---- 流式 completion（快捷助手流式回复） ----

  ipcMain.handle(
    IpcChannel.Dsh_StreamComplete,
    async (
      event,
      payload: {
        requestId: string
        provider: string
        model: string
        system?: string
        messages: { role: 'user' | 'assistant'; text: string }[]
        maxTokens?: number
        reasoningEffort?: string
      }
    ) => {
      const ctx = requireKernel()
      const { requestId, provider, model } = payload
      const reasoningEffort = await reasoning(ctx).resolveRequest(provider, model, payload.reasoningEffort)
      const send = (data: object): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannel.Dsh_CompletionEvent, { requestId, ...data })
        }
      }
      const options = {
        provider,
        model,
        messages: payload.messages.map((message) =>
          message.role === 'user'
            ? createUserMessage({
                content: [{ type: 'text', text: message.text }],
                source: { kind: 'plugin', plugin: 'cherry-stream-complete' }
              })
            : createAssistantMessage({
                content: [{ type: 'text', text: message.text }],
                source: { provider, model }
              })
        ),
        ...(payload.system === undefined || payload.system.length === 0 ? {} : { system: payload.system }),
        ...(payload.maxTokens === undefined ? {} : { maxTokens: payload.maxTokens }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) })
      }
      try {
        let finished = false
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'text-delta') {
            send({ type: 'delta', text: chunk.text })
          } else if (chunk.type === 'reasoning-delta') {
            send({ type: 'reasoning-delta', text: chunk.text })
          } else if (chunk.type === 'finish') {
            // 流已产出终态 chunk（文本输出完毕）。立即收尾并跳出循环，
            // 不依赖适配器在 finish 之后是否还会正常返回迭代结束——
            // 否则连接挂起时 for-await 永不结束，done 永远到不了 UI。
            finished = true
            if (chunk.reason?.kind === 'error') {
              const failure = chunk.reason.failure as { message?: string } | undefined
              send({ type: 'error', message: failure?.message || 'stream error' })
            } else if (chunk.reason?.kind === 'aborted') {
              send({ type: 'error', message: 'stream aborted' })
            } else {
              send({ type: 'done' })
            }
            break
          }
        }
        if (!finished) {
          send({ type: 'done' })
        }
        return { ok: true }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        return { ok: false }
      }
    }
  )

  // ---- 话题 ----

  ipcMain.handle(IpcChannel.Dsh_TopicList, () => {
    return { topics: listTopics() }
  })

  ipcMain.handle(
    IpcChannel.Dsh_TopicCreate,
    async (
      _event,
      input: {
        id: string
        name?: string
        provider: string
        model: string
        maxTokens?: number
        systemPrompt?: string
        reasoningEffort?: string
        workingDir?: string
      }
    ) => {
      return { topic: await topicTree(requireKernel()).create(input) }
    }
  )

  ipcMain.handle(IpcChannel.Dsh_TopicRename, async (_event, id: string, name: string) => {
    return { topic: await topicTree(requireKernel()).rename(id, name) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicDelete, async (_event, id: string) => {
    await topicTree(requireKernel()).delete(id)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicDestroyTurns, async (_event, id: string, anchorUserSeqs: number[]) => {
    return await topicTree(requireKernel()).destroyTurns(id, anchorUserSeqs)
  })

  ipcMain.handle(IpcChannel.Dsh_TopicOpen, async (_event, id: string) => {
    await topicTree(requireKernel()).open(id)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicFork, async (_event, sourceTopicId: string, anchorUserMessageSeq: number) => {
    return { topic: await topicTree(requireKernel()).fork(sourceTopicId, anchorUserMessageSeq) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicBranches, (_event, rootTopicId: string) => {
    return { topics: listTopicBranches(rootTopicId) }
  })

  ipcMain.handle(
    IpcChannel.Dsh_TopicSend,
    async (
      _event,
      id: string,
      text: string,
      options?: {
        reasoningEffort?: string
        workMode?: boolean
        workModeTier?: string
        builtinTools?: string[]
        externalTools?: string[]
      }
    ) => {
      const cleanOptions: {
        reasoningEffort?: string
        workMode?: boolean
        workModeTier?: string
        builtinTools?: string[]
        externalTools?: string[]
      } = {}
      if (options?.reasoningEffort !== undefined) {
        if (typeof options.reasoningEffort !== 'string') {
          throw new Error('kernel: invalid reasoningEffort in topic send options')
        }
        cleanOptions.reasoningEffort = options.reasoningEffort
      }
      if (options?.workMode !== undefined) {
        if (typeof options.workMode !== 'boolean') {
          throw new Error('kernel: invalid workMode in topic send options')
        }
        cleanOptions.workMode = options.workMode
      }
      if (options?.workModeTier !== undefined) {
        if (typeof options.workModeTier !== 'string' || !WORK_MODE_APPROVAL_TIERS.includes(options.workModeTier)) {
          throw new Error('kernel: invalid workModeTier in topic send options')
        }
        cleanOptions.workModeTier = options.workModeTier
      }
      if (options?.builtinTools !== undefined) {
        if (!Array.isArray(options.builtinTools) || options.builtinTools.some((toolId) => typeof toolId !== 'string')) {
          throw new Error('kernel: invalid builtinTools in topic send options')
        }
        cleanOptions.builtinTools = options.builtinTools
      }
      if (options?.externalTools !== undefined) {
        if (!Array.isArray(options.externalTools) || options.externalTools.some((toolId) => typeof toolId !== 'string')) {
          throw new Error('kernel: invalid externalTools in topic send options')
        }
        cleanOptions.externalTools = options.externalTools
      }
      await topicTree(requireKernel()).send(id, text, cleanOptions)
      return { ok: true }
    }
  )

  ipcMain.handle(IpcChannel.Dsh_TopicStop, (_event, id: string) => {
    topicTree(requireKernel()).stop(id)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicRunning, (_event, id: string) => {
    return { running: topicTree(requireKernel()).isRunning(id) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicEvents, async (_event, id: string) => {
    const ctx = requireKernel()
    const tree = topicTree(ctx)
    // 必须 await：重启后 agent 需从持久化异步 resume，
    // 不同步等待则下方 events 取不到 agent 而抛 "session is not loaded"
    await tree.open(id)
    return { events: tree.events(id) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicGet, (_event, id: string) => {
    return { topic: getTopic(id) }
  })

  ipcMain.handle(IpcChannel.Dsh_SearchMessages, async (_event, terms: string[]) => {
    return { hits: await searchSessions(requireKernel(), terms) }
  })

  // ---- 审批/问答回执（Step 2）----

  ipcMain.handle(IpcChannel.Dsh_ApprovalDecide, (_event, decision: KernelApprovalDecisionPayload) => {
    if (
      decision === null ||
      typeof decision !== 'object' ||
      typeof decision.requestId !== 'string' ||
      (decision.behavior !== 'allow' && decision.behavior !== 'deny')
    ) {
      throw new Error('kernel: invalid approval decision payload')
    }
    return { ok: interactionHub?.decideApproval(decision) ?? false }
  })

  ipcMain.handle(IpcChannel.Dsh_QuestionAnswer, (_event, answer: KernelQuestionAnswerPayload) => {
    if (
      answer === null ||
      typeof answer !== 'object' ||
      typeof answer.requestId !== 'string' ||
      !Array.isArray(answer.answers)
    ) {
      throw new Error('kernel: invalid question answer payload')
    }
    return { ok: interactionHub?.answerQuestion(answer) ?? false }
  })
}
