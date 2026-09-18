import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GATE_KEY,
  installThinkingReplayTrim,
  trimPriorTurnThinking,
  uninstallThinkingReplayTrim
} from '../thinkingReplay'

/**
 * 既往 turn 思考剥离的单元契约（形状全部取自 2026-09-17 probe-toolloop-shape
 * 真机管道实测，不是想象）：
 *   - dsh 工具结果 = user-role + tool-result 块（source.kind==='tool'）——不能当边界；
 *   - 注入快照 = user-role 文本以 "Current runtime context." 开头——不能当边界；
 *   - assistant 载体 = reasoning + text / reasoning + tool-call 块；
 *   - agent-loop 请求到达此处时已深冻结（读取可、改写抛错）。
 */

/** dsh 块的最小构造器（测试只用到的四种）。 */
const text = (t: string) => ({ type: 'text', text: t })
const reasoning = (t: string) => ({ type: 'reasoning', text: t })
const toolCall = (name: string) => ({ type: 'tool-call', name, arguments: '{}' })
const toolResult = (id: string) => ({ type: 'tool-result', toolCallId: id, content: 'ok', isError: false })

/** 真实用户消息。 */
const user = (t: string) => ({ role: 'user', content: [text(t)] })
/** 注入快照（user-role，前缀约定）。 */
const snapshot = () => ({ role: 'user', content: [text('Current runtime context.\n沙箱档位等')] })
/** 工具结果消息（dsh 词表：user-role + source.kind==='tool'）。 */
const toolResultMessage = (id: string) => ({
  role: 'user',
  source: { kind: 'tool', callId: id },
  content: [toolResult(id)]
})

/** 探针 call #4 的原样形状（三个回合，turn1 带工具循环）。 */
const probeShape = () => [
  user('帮我看看这个文件'),
  snapshot(),
  {
    role: 'assistant',
    source: { kind: 'model' },
    content: [reasoning('第一步思考…'), toolCall('read')]
  },
  toolResultMessage('call_probe_1'),
  {
    role: 'assistant',
    source: { kind: 'model' },
    content: [reasoning('后续步思考…'), text('工具轮完成：这是助手的正式答复。')]
  },
  user('第二轮：你好'),
  {
    role: 'assistant',
    source: { kind: 'model' },
    content: [reasoning('第二轮思考…'), text('第二轮答复。')]
  },
  user('第三轮：结束')
]

const opts = (messages: unknown[]) => ({ provider: 'silicon', model: 'kimi', messages }) as never

afterEach(() => {
  uninstallThinkingReplayTrim()
})

describe('trimPriorTurnThinking：既往 turn 剥离', () => {
  it('既往 turn 的 reasoning 全剥离；正文与工具调用块原样保留', () => {
    const shape = probeShape()
    const out = trimPriorTurnThinking(opts(shape))
    const messages = out.messages as Array<{
      role: string
      content: Array<{ type: string; text?: string; name?: string }>
    }>

    // 长度一致（没有只含思考的消息，无人被下线）
    expect(messages).toHaveLength(8)

    // turn1 step1：reasoning 掉、tool-call 留
    expect(messages[2].role).toBe('assistant')
    expect(messages[2].content.map((b) => b.type)).toEqual(['tool-call'])
    expect(messages[2].content[0].name).toBe('read')

    // turn1 step2：reasoning 掉、text 留
    expect(messages[4].content.map((b) => b.type)).toEqual(['text'])
    expect(messages[4].content[0].text).toContain('正式答复')

    // turn2 的 assistant 在 turn3 请求里也是既往 turn：reasoning 掉、text 留
    expect(messages[6].content.map((b) => b.type)).toEqual(['text'])

    // 用户消息、快照、工具结果原样透传（同一引用）
    expect(messages[0]).toBe(shape[0])
    expect(messages[1]).toBe(shape[1])
    expect(messages[3]).toBe(shape[3])
  })

  it('只含思考块的既往 assistant：整条下线（防 Anthropic 空内容拒绝）', () => {
    const out = trimPriorTurnThinking(
      opts([
        user('第一问'),
        { role: 'assistant', source: { kind: 'model' }, content: [reasoning('只想了没说')] },
        user('第二问')
      ])
    )
    const messages = out.messages as Array<{ role: string; content: unknown[] }>
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('多步工具循环的续步：边界之前的当步思考保留（同一对象，恒等返回）', () => {
    // 探针 call #2 形状：回合进行中（最后的消息是工具结果，无新的真实用户消息）
    const messages = [
      user('帮我看看这个文件'),
      snapshot(),
      { role: 'assistant', source: { kind: 'model' }, content: [reasoning('第一步思考…'), toolCall('read')] },
      toolResultMessage('call_probe_1')
    ]
    const request = opts(messages)
    const out = trimPriorTurnThinking(request)
    expect(out).toBe(request) // 无任何剥离
  })

  it('快照与工具结果都不劫持边界；最后一条真实用户消息之后的思考是 turn 内', () => {
    // turn2 已开工具链：user2 之后有 assistant(reason+toolcall) + tool结果 —— 全部保留
    const messages = [
      user('turn1'),
      { role: 'assistant', source: { kind: 'model' }, content: [reasoning('旧思考'), text('旧答复')] },
      user('turn2'),
      snapshot(), // 快照可能插在回合中间
      { role: 'assistant', source: { kind: 'model' }, content: [reasoning('当步思考'), toolCall('read')] },
      toolResultMessage('c1')
    ]
    const request = opts(messages)
    const out = trimPriorTurnThinking(request)
    const content = (out.messages as Array<{ content: Array<{ type: string }> }>)[4].content
    expect(content.map((b) => b.type)).toEqual(['reasoning', 'tool-call'])
    const prior = (out.messages as Array<{ content: Array<{ type: string }> }>)[1].content
    expect(prior.map((b) => b.type)).toEqual(['text'])
  })

  it('无可剥离（无 reasoning）→ 恒等返回', () => {
    const messages = [
      user('第一问'),
      { role: 'assistant', source: { kind: 'model' }, content: [text('纯正文')] },
      user('第二问')
    ]
    const request = opts(messages)
    expect(trimPriorTurnThinking(request)).toBe(request)
  })

  it('无合格边界（全是 assistant/工具结果/快照）→ 恒等返回（fail-safe 全保留）', () => {
    const messages = [
      snapshot(),
      { role: 'assistant', source: { kind: 'model' }, content: [reasoning('思考')] },
      toolResultMessage('c1')
    ]
    const request = opts(messages)
    expect(trimPriorTurnThinking(request)).toBe(request)
  })

  it('深冻结的 agent-loop 请求：不抛错、不改写原件', () => {
    const request = deepFreeze(opts(probeShape()))
    const before = JSON.stringify(request)
    const out = trimPriorTurnThinking(request)
    expect(out).not.toBe(request)
    expect(JSON.stringify(request)).toBe(before) // 原件未被触碰
    // 冻结件里的块引用被共享只读，不复制整个世界
    expect((out.messages as unknown[])[0]).toBe((request as { messages: unknown[] }).messages[0])
  })

  it('形状异常宽容：content 非数组 / 不明块类型 → 不动它们', () => {
    const messages = [
      user('第一问'),
      { role: 'assistant', source: { kind: 'model' }, content: 'string-content（异常形状）' },
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'mystery' }] },
      user('第二问')
    ]
    const request = opts(messages)
    const out = trimPriorTurnThinking(request)
    expect(out.messages).toHaveLength(4)
    expect((out.messages as Array<{ content: unknown }>)[1].content).toBe('string-content（异常形状）')
    expect((out.messages as Array<{ content: unknown }>)[2].content).toEqual([{ type: 'mystery' }])
  })

  it('非 assistant 角色（user/tool 结果）带 reasoning 形状 → 不动', () => {
    const messages = [user('第一问'), { role: 'user', content: [reasoning('不该出现在 user 里的块')] }, user('第二问')]
    const request = opts(messages)
    const out = trimPriorTurnThinking(request)
    expect((out.messages as Array<{ content: unknown }>)[1].content).toEqual([reasoning('不该出现在 user 里的块')])
  })
})

describe('中性门（globalThis 钩子）', () => {
  it('install 装一次成功、重复装被拒；uninstall 摘除', () => {
    expect((globalThis as Record<string, unknown>)[GATE_KEY]).toBeUndefined()
    expect(installThinkingReplayTrim()).toBe(true)
    expect(typeof (globalThis as Record<string, unknown>)[GATE_KEY]).toBe('function')
    expect(installThinkingReplayTrim()).toBe(false) // 二次装 = 幂等拒绝
    uninstallThinkingReplayTrim()
    expect((globalThis as Record<string, unknown>)[GATE_KEY]).toBeUndefined()
  })

  it('装上的门就是剥离函数：真实形状进 → 剥离后的新对象出', () => {
    installThinkingReplayTrim()
    const gate = (globalThis as unknown as { [GATE_KEY]: (v: unknown) => unknown })[GATE_KEY]
    const out = gate(opts(probeShape())) as { messages: Array<{ content: Array<{ type: string }> }> }
    expect(out.messages).toHaveLength(8)
    expect(out.messages[2].content.map((b) => b.type)).toEqual(['tool-call'])
  })

  it('门对敌意输入 fail-safe：垃圾进垃圾出、永不抛错', () => {
    installThinkingReplayTrim()
    const gate = (globalThis as unknown as { [GATE_KEY]: (v: unknown) => unknown })[GATE_KEY]
    expect(gate(null)).toBeNull()
    expect(gate(undefined)).toBeUndefined()
    expect(gate('garbage')).toBe('garbage')
    expect(gate(42)).toBe(42)
    const noMessages = { provider: 'x' } as never
    expect(gate(noMessages)).toBe(noMessages)
    const emptyMessages = { provider: 'x', messages: [] } as never
    expect(gate(emptyMessages)).toBe(emptyMessages)
  })

  it('补丁侧行为的门面：门缺失时 `globalThis.__recTrimPriorTurnThinking?.(o) ?? o` 回落到原对象', () => {
    // 这正是补丁在被 pi-ai 执行的那一行表达式；门未装 = 零行为差异。
    const options = opts(probeShape())
    const effective =
      (globalThis as unknown as { [GATE_KEY]?: (v: unknown) => unknown })[GATE_KEY]?.(options) ?? options
    expect(effective).toBe(options)
  })
})
