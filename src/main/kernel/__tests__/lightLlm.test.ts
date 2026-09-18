import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { lightOneShot, lightStream } from '../lightLlm'

/**
 * 轻量 LLM 服务机测：真 BlockAssembler + 真消息工厂，只 fake ctx.llm.stream 与
 * ctx.reasoning seam。钉住的语义：
 *   - 一次性调用思考缺省解析为 off（seam 收到 'off'；off 不支持时 seam 返回
 *     undefined → 不带档位参数，绝不就近升档）
 *   - 流式调用思考缺省 = 模型默认（seam 收到 undefined）
 *   - finish 即收尾（error/aborted → error 事件；正常 → done；无 finish 耗尽 → done）
 *   - source 标签消毒（元数据不收任意字符串）；maxTokens ≤ 0 不下发
 */

interface CapturedOptions {
  provider: string
  model: string
  messages: Array<{ role?: string; source?: { kind?: string; plugin?: string; provider?: string; model?: string } }>
  system?: string
  maxTokens?: number
  reasoningEffort?: string
}

function makeCtx(
  chunks: StreamChunk[],
  options: { resolveRequest?: (p: string, m: string, r?: string) => Promise<string | undefined> } = {}
): { ctx: Context; captured: CapturedOptions[]; resolveCalls: Array<[string, string, string | undefined]> } {
  const captured: CapturedOptions[] = []
  const resolveCalls: Array<[string, string, string | undefined]> = []
  const resolveRequest =
    options.resolveRequest ??
    (async (p: string, m: string, r?: string) => {
      resolveCalls.push([p, m, r])
      return r
    })
  const ctx = {
    llm: {
      stream: async function* (callOptions: CapturedOptions) {
        captured.push(callOptions)
        for (const chunk of chunks) yield chunk
      }
    },
    reasoning: { resolveRequest }
  } as unknown as Context
  return { ctx, captured, resolveCalls }
}

const textChunk = (index: number, text: string): StreamChunk => ({ type: 'text-delta', index, text })
const finishStop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

describe('lightOneShot', () => {
  it('聚合文本块并回传用量与 finishKind；一次性缺省思考解析为 off', async () => {
    const { ctx, captured, resolveCalls } = makeCtx([
      textChunk(0, '你好'),
      textChunk(0, '，世界'),
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } },
      finishStop
    ])

    const result = await lightOneShot(ctx, {
      provider: 'silicon',
      model: 'qwen',
      messages: [{ role: 'user', text: '打招呼' }],
      maxTokens: 128,
      source: 'cherry-topic-naming'
    })

    expect(result.text).toBe('你好，世界')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
    expect(result.finishKind).toBe('stop')
    expect(resolveCalls).toEqual([['silicon', 'qwen', 'off']])

    const options = captured[0]
    expect(options.messages).toHaveLength(1)
    expect(options.messages[0]?.source).toEqual({ kind: 'plugin', plugin: 'cherry-topic-naming' })
    expect(options.maxTokens).toBe(128)
    expect((options.reasoningEffort as unknown as string) ?? undefined).toBe('off')
  })

  it('显式档位透传给 seam；seam 收敛为 undefined（off 不被支持）时不带档位参数', async () => {
    const { ctx, captured } = makeCtx([finishStop], {
      resolveRequest: async () => undefined
    })

    await lightOneShot(ctx, {
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', text: 'x' }],
      reasoningEffort: 'high'
    })

    const options = captured[0]
    expect('reasoningEffort' in options).toBe(false)
  })

  it('错误终态抛错（调用方决定降级）；中断终态同', async () => {
    const { ctx } = makeCtx([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } as never } }])
    await expect(
      lightOneShot(ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] })
    ).rejects.toThrow('boom')
  })

  it('system 空串省略、maxTokens ≤ 0 省略、source 消毒与缺省回退', async () => {
    const { ctx, captured } = makeCtx([finishStop])

    await lightOneShot(ctx, {
      provider: 'p',
      model: 'm',
      system: '',
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: 'a' }
      ],
      maxTokens: 0,
      source: 'My Fancy/Tag!'
    })

    const options = captured[0]
    expect('system' in options).toBe(false)
    expect('maxTokens' in options).toBe(false)
    // 助手上文消息带模型溯源；user 消息带消毒后的插件标签
    expect(options.messages[1]?.source?.kind).toBe('model')
    expect(options.messages[0]?.source?.plugin).toBe('my-fancy-tag-')

    const fallback = makeCtx([finishStop])
    await lightOneShot(fallback.ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] })
    expect(fallback.captured[0].messages[0]?.source?.plugin).toBe('cherry-light')
  })
})

describe('lightStream', () => {
  it('chunk → 规范化事件；finish 即收尾只发一个 done；思考缺省不问 seam', async () => {
    const { ctx, captured } = makeCtx([
      textChunk(0, '回'),
      { type: 'reasoning-delta', index: 1, text: '想' },
      textChunk(0, '答'),
      finishStop
    ])
    const events: Array<{ type: string; text?: string; message?: string }> = []

    await lightStream(ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] }, (event) => {
      events.push(event as { type: string; text?: string })
    })

    expect(events).toEqual([
      { type: 'delta', text: '回' },
      { type: 'reasoning-delta', text: '想' },
      { type: 'delta', text: '答' },
      { type: 'done' }
    ])
    // 流式缺省：不发档位（模型默认），seam 不被调用（assembleCall 直接跳过）
    expect('reasoningEffort' in captured[0]).toBe(false)
  })

  it('error/aborted 终态发 error 事件且不发 done', async () => {
    const { ctx } = makeCtx([{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } as never } }])
    const events: string[] = []
    await lightStream(ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] }, (e) =>
      events.push(e.type)
    )
    expect(events).toEqual(['error'])

    const aborted = makeCtx([{ type: 'finish', reason: { kind: 'aborted', failure: {} as never } }])
    const events2: string[] = []
    await lightStream(aborted.ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] }, (e) =>
      events2.push(e.type)
    )
    expect(events2).toEqual(['error'])
  })

  it('无 finish 而迭代耗尽 → 补 done；流中异常 → error 事件、不抛', async () => {
    const exhausted = makeCtx([textChunk(0, '部分')])
    const events: string[] = []
    await lightStream(exhausted.ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] }, (e) =>
      events.push(e.type)
    )
    expect(events).toEqual(['delta', 'done'])

    const boom = makeCtx([finishStop])
    ;(boom.ctx as unknown as { llm: { stream: () => AsyncGenerator<StreamChunk> } }).llm.stream = async function* () {
      throw new Error('wire dead')
    }
    const events2: string[] = []
    await lightStream(boom.ctx, { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }] }, (e) =>
      events2.push(e.type)
    )
    expect(events2).toEqual(['error'])
  })

  it('快捷助手显式档位透传（seam 参与收敛）', async () => {
    const { ctx, captured } = makeCtx([finishStop])
    await lightStream(
      ctx,
      { provider: 'p', model: 'm', messages: [{ role: 'user', text: 'x' }], reasoningEffort: 'medium' },
      () => {}
    )
    expect((captured[0].reasoningEffort as unknown as string) ?? undefined).toBe('medium')
  })
})
