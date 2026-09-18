import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { registerDsmlRepair } from '../dsmlRepair'

/**
 * DSML 修复中间件的**运行期**验证（不只是纯函数单测）。
 *
 * 为什么需要它：v0.3.0-1 把修复从"pnpm patch 内核包"迁到 fork 自己的 `llm/stream` waterfall 上，
 * 其正确性依赖三个只有真跑才知道的事实：
 *   1. 中间件确实被挂进 `llm/stream` waterfall（而不是挂了个没人触发的监听）；
 *   2. 它确实委托了 `next()`（waterfall 不委托就会短路，适配器根本不会被调用）；
 *   3. **两条取流路径都覆盖**——`ctx.llm.stream()` 与 `prepareCall().stream()`（agent-loop
 *      在 `agent.ts` 里是 `preparedCall?.stream(...) ?? ctx.llm.stream(...)`，两条都要过这里）。
 *
 * 这里用真实 cordis Context + 真实 LlmRuntime + 假适配器（假适配器只回放一段"泄漏"的文本块）
 * 端到端跑一遍，因此结论是运行期证据，而不是"我读代码觉得它应该被调用"。
 */
const BAR = '\uFF5C' // ｜（DSML 标记用的全角竖线）

/** 真机泄漏样本形状：包裹标记 + invoke + arguments 参数。 */
const LEAKED_TEXT = [
  `<${BAR}DSML${BAR}tool_calls>`,
  `<${BAR}DSML${BAR}invoke name="read">`,
  `<${BAR}DSML${BAR}parameter name="arguments">{"path":"a.txt"}</${BAR}DSML${BAR}parameter>`,
  `</${BAR}DSML${BAR}invoke>`,
  `</${BAR}DSML${BAR}tool_calls>`
].join('\n')

/** 回放"服务端没抽出工具调用、把标记漏进正文"的适配器。 */
class LeakingAdapter extends LlmAdapter {
  calls = 0

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: LEAKED_TEXT } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function boot({ repair }: { repair: boolean }): Promise<{ ctx: Context; adapter: LeakingAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new LeakingAdapter()
  ctx.llm.registerAdapter(['test-provider'], adapter)
  if (repair) registerDsmlRepair(ctx)
  return { ctx, adapter }
}

const request: GenerateOptions = { provider: 'test-provider', model: 'test-model', messages: [] }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks
    .flatMap((chunk) => (chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []))
    .join('')

const toolCalls = (chunks: StreamChunk[]): StreamChunk[] =>
  chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')

describe('DSML 修复中间件（llm/stream waterfall，运行期）', () => {
  it('对照组：没有中间件时，泄漏原样留在文本里（且完全没有工具调用块）', async () => {
    const { ctx, adapter } = await boot({ repair: false })
    const chunks = await collect(ctx.llm.stream(request))

    expect(adapter.calls).toBe(1)
    expect(textOf(chunks)).toBe(LEAKED_TEXT)
    expect(toolCalls(chunks)).toHaveLength(0)
  })

  it('路径一 ctx.llm.stream()：泄漏被转成真 tool-call 块，正文不再含标记', async () => {
    const { ctx, adapter } = await boot({ repair: true })
    const chunks = await collect(ctx.llm.stream(request))

    // 适配器被真正调用过 → 中间件委托了 next()，没有短路 waterfall
    expect(adapter.calls).toBe(1)
    expect(textOf(chunks)).not.toContain('DSML')
    const repaired = toolCalls(chunks)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]).toMatchObject({
      block: { type: 'tool-call', name: 'read', arguments: '{"path":"a.txt"}' }
    })
    // 终止块不受影响
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('路径二 prepareCall().stream()（agent-loop 的另一条取流路径）也被覆盖', async () => {
    const { ctx, adapter } = await boot({ repair: true })
    const prepared = await ctx.llm.prepareCall({ provider: 'test-provider', model: 'test-model' })
    const chunks = await collect(prepared.stream({ ...prepared.config, messages: [] }))

    expect(adapter.calls).toBe(1)
    expect(textOf(chunks)).not.toContain('DSML')
    expect(toolCalls(chunks)).toHaveLength(1)
  })

  it('多个中间件可共存：后注册的监听器位于链内侧（看到修复前的原始块）', async () => {
    const { ctx } = await boot({ repair: true })
    let observed = 0
    ctx.on('llm/stream', (_options, next) => {
      const source = next()
      return (async function* () {
        for await (const chunk of source) {
          observed += 1
          yield chunk
        }
      })()
    })

    const chunks = await collect(ctx.llm.stream(request))

    // 实测语义：cordis waterfall 里**先注册者在链外侧**，故后注册的观察者拿到的是修复前的
    // 原始块（block-start + block-end(text) + finish = 3），而最终输出是修复后的 6 块。
    // 若内核升级改变这一顺序语义，本条会红——那时要复核的是我们中间件相对其他监听器的位置
    // （曾有上游监听器（标题服务）用 prepend:true 抢最外层，但纯观察不改道，故互不影响）。
    expect(observed).toBe(3)
    expect(chunks).toHaveLength(6)
    expect(chunks.flatMap((chunk) => (chunk.type === 'finish' ? [chunk] : []))).toHaveLength(1)
    expect(toolCalls(chunks)).toHaveLength(1)
  })
})
