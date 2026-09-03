import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as piAiPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { registerSessionTitleLlmProvider } from '@deepseek-ai/dsh-session-title-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, ipcMain } from 'electron'

import { CherryCredentialProvider } from './credentials'
import { type KernelProviderInput, syncCherryProviders } from './providers'
import {
  createTopic,
  deleteTopic,
  getTopic,
  initTopics,
  isTopicRunning,
  listTopics,
  openTopic,
  renameTopic,
  searchSessions,
  sendMessage,
  sessionEvents,
  stopTopic
} from './topics'

const logger = loggerService.withContext('Kernel')

let kernelContext: Context | undefined

/** 已启动的内核上下文；未启动或已销毁时为 undefined。 */
export function getKernel(): Context | undefined {
  return kernelContext
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

    await initTopics(ctx)
    registerKernelIpc()
    registerEventForwarding(ctx)

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
      }
    ) => {
      const ctx = requireKernel()
      const { provider, model } = payload
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
        ...(payload.maxTokens === undefined ? {} : { maxTokens: payload.maxTokens })
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
      }
    ) => {
      const ctx = requireKernel()
      const { requestId, provider, model } = payload
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
        ...(payload.maxTokens === undefined ? {} : { maxTokens: payload.maxTokens })
      }
      try {
        let finished = false
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'text-delta') {
            send({ type: 'delta', text: chunk.text })
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
      input: { id: string; name?: string; provider: string; model: string; maxTokens?: number; systemPrompt?: string }
    ) => {
      return { topic: await createTopic(requireKernel(), input) }
    }
  )

  ipcMain.handle(IpcChannel.Dsh_TopicRename, async (_event, id: string, name: string) => {
    return { topic: await renameTopic(id, name) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicDelete, async (_event, id: string) => {
    await deleteTopic(id)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicOpen, async (_event, id: string) => {
    await openTopic(requireKernel(), id)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicSend, async (_event, id: string, text: string) => {
    const ctx = requireKernel()
    await sendMessage(ctx, id, text)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicStop, (_event, id: string) => {
    stopTopic(requireKernel(), id)
    return { ok: true }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicRunning, (_event, id: string) => {
    return { running: isTopicRunning(requireKernel(), id) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicEvents, (_event, id: string) => {
    const ctx = requireKernel()
    void openTopic(ctx, id)
    return { events: sessionEvents(ctx, id) }
  })

  ipcMain.handle(IpcChannel.Dsh_TopicGet, (_event, id: string) => {
    return { topic: getTopic(id) }
  })

  ipcMain.handle(IpcChannel.Dsh_SearchMessages, async (_event, terms: string[]) => {
    return { hits: await searchSessions(requireKernel(), terms) }
  })
}
