/**
 * 轻量 LLM 服务（独立内核面）。
 *
 * 快捷助手（流式）、话题命名/快速模型、错误诊断、健康检查、冒烟，以及未来的
 * 翻译 / 知识库相关模型调用 / 搜索编排等一切"功能需要用一下 AI"的场景，
 * **统一从这里过**——不建 session、不建 agent、不挂工具，直接 ctx.llm.stream
 * 一次往返。此前各 IPC handler 内联实现（kernel/index.ts 的 Dsh_Complete /
 * Dsh_StreamComplete / Dsh_StreamSmoke 三份近似拷贝），本模块把它们收敛为
 * 单一服务：消息构造、思考档位解析（含一次性调用默认 off）、chunk 映射、
 * 错误归一都在这里，handler 只剩薄转发。
 *
 * 契约合规：走 ctx.llm 公共 seam + ctx.reasoning 服务 seam（插件接管照常生效），
 * 无任何直连 SQLite/绕过 cordis 生命周期的路径。provider 路由与思考协议 compat
 * 由 syncCherryProviders 维护，轻量调用自动继承（含开发者角色/enable_thinking 修正）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { loggerService } from '@logger'
import type { LightLlmCall, LightLlmStreamEvent, LightLlmUsage } from '@shared/lightLlm/types'

const logger = loggerService.withContext('KernelLightLlm')

/** ctx.reasoning 服务访问器（与 kernel/index.ts 同一 seam 语义；插件可接管）。 */
function reasoningSeam(ctx: Context): {
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

/** 调用方标签消毒：非 [a-z0-9-] 一律替换，防止任意字符串流进消息溯源元数据。 */
function sanitizeSource(source: string | undefined, fallback: string): string {
  const tag = (source ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return tag.length > 0 ? tag.slice(0, 64) : fallback
}

async function assembleCall(
  ctx: Context,
  call: LightLlmCall,
  reasoningDefault: string | undefined
): Promise<{
  options: {
    provider: string
    model: string
    messages: Array<UserMessage | AssistantMessage>
    system?: string
    maxTokens?: number
    reasoningEffort?: ReturnType<typeof ReasoningEffortId>
  }
}> {
  const source = sanitizeSource(call.source, 'cherry-light')
  const requested = call.reasoningEffort ?? reasoningDefault
  const reasoningEffort =
    requested === undefined ? undefined : await reasoningSeam(ctx).resolveRequest(call.provider, call.model, requested)
  const messages = call.messages.map((message) =>
    message.role === 'user'
      ? createUserMessage({
          content: [{ type: 'text', text: message.text }],
          source: { kind: 'plugin', plugin: source }
        })
      : createAssistantMessage({
          content: [{ type: 'text', text: message.text }],
          source: { provider: call.provider, model: call.model }
        })
  )
  return {
    options: {
      provider: call.provider,
      model: call.model,
      messages,
      ...(call.system === undefined || call.system.length === 0 ? {} : { system: call.system }),
      ...(call.maxTokens === undefined || call.maxTokens <= 0 ? {} : { maxTokens: call.maxTokens }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) })
    }
  }
}

/**
 * 一次性补全：聚合完整文本后返回；错误/中断抛 Error（调用方 catch）。
 * 思考缺省解析为 off（工具型生成不需要思考；off 不被模型支持时自动弱化为
 * 不发参数——pickReasoningLevel 对 off 从不就近升档）。
 */
export async function lightOneShot(
  ctx: Context,
  call: LightLlmCall
): Promise<{ text: string; usage?: LightLlmUsage; finishKind: string }> {
  const { options } = await assembleCall(ctx, call, 'off')
  const assembler = new BlockAssembler()
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
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  const usage = assembler.usage
    ? { inputTokens: assembler.usage.inputTokens, outputTokens: assembler.usage.outputTokens }
    : undefined
  logger.debug('lightLlm one-shot done', {
    source: sanitizeSource(call.source, 'cherry-light'),
    provider: call.provider,
    model: call.model,
    chars: text.length,
    finishKind: finish.kind
  })
  return { text, usage, finishKind: finish.kind }
}

/**
 * 流式补全：chunk → 规范化事件（delta/reasoning-delta/error/done），错误经事件面
 * 传递、不抛。finish chunk 即收尾并跳出循环（不依赖适配器在 finish 后是否正常
 * 返回迭代结束——连接挂起时 for-await 永不结束，done 永远到不了 UI）；正常终点
 * 发 done，error/aborted 终点发 error；迭代耗尽而无 finish 时补 done。
 * 思考档位缺省 = 模型默认（快捷助手的显式档位照常透传）。
 */
export async function lightStream(
  ctx: Context,
  call: LightLlmCall,
  onEvent: (event: LightLlmStreamEvent) => void
): Promise<void> {
  try {
    const { options } = await assembleCall(ctx, call, undefined)
    let finished = false
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        onEvent({ type: 'delta', text: chunk.text })
      } else if (chunk.type === 'reasoning-delta') {
        onEvent({ type: 'reasoning-delta', text: chunk.text })
      } else if (chunk.type === 'finish') {
        finished = true
        if (chunk.reason?.kind === 'error') {
          const failure = chunk.reason.failure as { message?: string } | undefined
          onEvent({ type: 'error', message: failure?.message || 'stream error' })
        } else if (chunk.reason?.kind === 'aborted') {
          onEvent({ type: 'error', message: 'stream aborted' })
        } else {
          onEvent({ type: 'done' })
        }
        break
      }
    }
    if (!finished) {
      onEvent({ type: 'done' })
    }
  } catch (error) {
    onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
