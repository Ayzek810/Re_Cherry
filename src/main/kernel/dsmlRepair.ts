/**
 * DSML 调用修复（响应端，恒开）—— `llm/stream` waterfall 中间件。
 *
 * 问题（v0.3.0 真机实锤）：DeepSeek 服务端会把模型输出的 DSML 工具调用标记抽成结构化
 * tool call，但抽取不稳定——同一会话可能这一轮正常解析，下一轮把**同样的标记原样漏进
 * 文本块**。漏掉的那一轮以"零工具调用"结束（无任何失败反馈），模型却以为调用已执行。
 *
 * 修复位置（v0.3.0-1 迁移）：v0.3.0 用 `pnpm patch` 改内核包 `dsh-llm-pi-ai` 的编译产物
 * `lib/index.js`，把补丁钉死在 `0.1.1-rc.2`（契约明确不喜欢动内核行为）。此处改用 dsh
 * 文档化的 **`llm/stream` waterfall 缝**（`@deepseek-ai/dsh-llm` LlmRuntime）：agent-loop 的
 * 两条取流路径——`ctx.llm.stream()`（agent.ts:346 回退分支）与 `prepareCall().stream()`
 * （同样经 streamWithRegistration）——都要过这个 waterfall，因此在 fork 自己的插件里包装
 * 流即可，语义不变、不动内核包、不再有版本钉死。生产内核包已有同款 listener 范式
 * （dsh-session-title、dsh-session-checkpoint-policy）。
 *
 * 语义与补丁逐字一致（fail-safe）：格式完好且参数为合法 JSON 的标记机械转换为真 tool-call
 * 块（正文剥离标记）；畸形标记或非 JSON 参数**原样透传**。已关闭的工具因不在 schema 中，
 * 被本中间件转成真调用后由 dsh 原生 `unknown tool` 结构化回执反馈给模型（带内反馈，不静默）。
 *
 * 恒开：不受任何开关约束——开关只关"模型是否拿到 schema"这一件事（v0.3.0 架构原则）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import { loggerService } from '@logger'

const logger = loggerService.withContext('KernelDsmlRepair')

/** 完整调用标记：`<｜DSML｜invoke name="x">…<｜DSML｜parameter name="arguments">{…}</｜DSML｜parameter>…</｜DSML｜invoke>`。 */
const DSML_INVOKE_PATTERN =
  /<｜DSML｜invoke name="([^"]+)">\s*<｜DSML｜parameter name="arguments"[^>]*>([\s\S]*?)<\/｜DSML｜parameter>\s*<\/｜DSML｜invoke>/g

/** 标记前缀：每个文本块先做一次廉价包含判断，命中才跑正则。 */
const DSML_INVOKE_PREFIX = '<｜DSML｜invoke name="'

/** 包裹标记（正文里残留的 `<｜DSML｜tool_calls>` / `</｜DSML｜tool_calls>`）。 */
const DSML_WRAPPER_PATTERN = /<\/?｜DSML｜tool_calls>/g

/** 同毫秒内多次修复的 id 去重计数（补丁用 Date.now+index，跨轮同毫秒可能撞）。 */
let repairSequence = 0

/**
 * 把一块泄漏的正文文本修复成"剥离后的正文 + 真 tool-call 块"。
 * @param chunk - 待检视的流块。
 * @returns 修复后的块序列；无需修复时返回 undefined（调用方原样透传）。
 */
export function repairDsmlChunk(chunk: StreamChunk): StreamChunk[] | undefined {
  if (chunk.type !== 'block-end') return undefined
  const block = chunk.block
  if (block.type !== 'text') return undefined
  const text = block.text
  if (!text.includes(DSML_INVOKE_PREFIX)) return undefined

  const calls: Array<{ name: string; argumentsJson: string }> = []
  // 注意：全局正则在 replace 中每次调用都会把 lastIndex 复位，模块级复用安全。
  const strippedText = text.replace(DSML_INVOKE_PATTERN, (match, name: string, argumentsRaw: string) => {
    try {
      const parsed = JSON.parse(argumentsRaw) as unknown
      calls.push({ name, argumentsJson: JSON.stringify(parsed) })
      return ''
    } catch {
      // 参数非法：保留原样，绝不猜测（fail-safe）
      return match
    }
  })
  if (calls.length === 0) return undefined

  const stripped = strippedText.replace(DSML_WRAPPER_PATTERN, '').replace(/\n{3,}/g, '\n\n')
  const repaired: StreamChunk[] = [{ type: 'block-end', index: chunk.index, block: { type: 'text', text: stripped } }]
  let nextIndex = chunk.index + 1
  for (const call of calls) {
    repairSequence += 1
    const callId = CallId(`dsml-repair-${Date.now().toString(36)}-${nextIndex}-${repairSequence.toString(36)}`)
    repaired.push({ type: 'block-start', index: nextIndex, blockType: 'tool-call' })
    repaired.push({
      type: 'tool-call-delta',
      index: nextIndex,
      id: callId,
      name: call.name,
      argumentsDelta: call.argumentsJson
    })
    repaired.push({
      type: 'block-end',
      index: nextIndex,
      block: { type: 'tool-call', id: callId, name: call.name, arguments: call.argumentsJson }
    })
    nextIndex += 1
  }
  return repaired
}

/** 包装整条流：逐块尝试修复，未命中即原样透传。 */
async function* repairDsmlStream(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    const repaired = repairDsmlChunk(chunk)
    if (repaired === undefined) {
      yield chunk
      continue
    }
    logger.warn(`kernel: DSML call markup leaked into text, repaired ${repaired.length} chunk(s)`)
    for (const item of repaired) yield item
  }
}

/**
 * 在 root 装配响应端修复中间件（`llm/stream` waterfall，必须委托 `next()`）。
 * @param ctx - 内核 root 上下文。
 */
export function registerDsmlRepair(ctx: Context): void {
  ctx.on('llm/stream', (_options, next) => repairDsmlStream(next()), { global: true })
  logger.info('kernel: DSML response-side repair registered on llm/stream')
}
