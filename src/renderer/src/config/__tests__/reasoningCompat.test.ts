import type { Model } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { providerReasoningCompat, type ReasoningCompatProviderInput } from '../reasoningCompat'

const createModel = (id: string) => ({ id, name: id, provider: 'x' }) as unknown as Model
const createProvider = (input: ReasoningCompatProviderInput) => input

const QWEN_TRIO = {
  thinkingFormat: 'qwen',
  supportsReasoningEffort: false,
  requiresReasoningContentOnAssistantMessages: true
}

describe('providerReasoningCompat（B 登记 / C 泛用推断 / A 用户声明 三层）', () => {
  // ---- B 层：已登记网关事实（网关级，文档背书） ----

  it('硅基流动非思考模型只拿 developer-role 修正（400 回归钉：bge-m3 无思考协议）', () => {
    const compat = providerReasoningCompat(
      createProvider({ id: 'silicon', apiHost: '', type: 'openai' }),
      createModel('BAAI/bge-m3')
    )
    expect(compat).toEqual({ supportsDeveloperRole: false })
  })

  it('硅基流动思考常开模型（R1）不发 enable_thinking，只拿基础修正', () => {
    const compat = providerReasoningCompat(
      createProvider({ id: 'x', apiHost: 'https://api.siliconflow.cn/v1', type: 'openai' }),
      createModel('deepseek-ai/DeepSeek-R1')
    )
    expect(compat).toEqual({ supportsDeveloperRole: false })
  })

  // ---- C 层：泛用家族推断（零登记：引擎不认识的网关自动获得 enable_thinking 协议） ----

  it('无名中转网关 × Qwen3 → qwen 三键（泛用解回归钉：不再逐网关登记）', () => {
    const compat = providerReasoningCompat(
      createProvider({ id: 'my-gw', apiHost: 'https://gw.example.com/v1', type: 'openai' }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(compat).toEqual(QWEN_TRIO)
  })

  it('无名中转网关 × Kimi 键族 → qwen 三键（Kimi-K2.6 曾被直发 reasoning_effort 且关不掉思考）', () => {
    const compat = providerReasoningCompat(
      createProvider({ id: 'my-gw', apiHost: 'https://gw.example.com/v1', type: 'new-api' }),
      createModel('Pro/moonshotai/Kimi-K2.6')
    )
    expect(compat).toEqual(QWEN_TRIO)
  })

  it('DashScope / 魔搭这类引挚名单外的官方兼容层同样命中推断', () => {
    const dashscope = providerReasoningCompat(
      createProvider({
        id: 'dashscope-x',
        apiHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        type: 'openai'
      }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(dashscope).toEqual(QWEN_TRIO)
  })

  it('引擎认识的网关（deepseek/moonshot 官方、openrouter）不干预——探测结果优先', () => {
    const deepseek = providerReasoningCompat(
      createProvider({ id: 'd', apiHost: 'https://api.deepseek.com/v1', type: 'openai' }),
      createModel('deepseek-chat')
    )
    expect(deepseek).toBeUndefined()
    const moonshot = providerReasoningCompat(
      createProvider({ id: 'm', apiHost: 'https://api.moonshot.cn/v1', type: 'openai' }),
      createModel('moonshotai/Kimi-K2.6')
    )
    expect(moonshot).toBeUndefined()
    const openrouter = providerReasoningCompat(
      createProvider({ id: 'o', apiHost: 'https://openrouter.ai/api/v1', type: 'openai' }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(openrouter).toBeUndefined()
  })

  it('非 OpenAI-completions 协议与上游黑名单网关不做推断', () => {
    const anthropic = providerReasoningCompat(
      createProvider({ id: 'a', apiHost: 'https://gw.example.com', type: 'anthropic' }),
      createModel('Pro/moonshotai/Kimi-K2.6')
    )
    expect(anthropic).toBeUndefined()
    const responses = providerReasoningCompat(
      createProvider({ id: 'r', apiHost: 'https://gw.example.com', type: 'openai-response' }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(responses).toBeUndefined()
    const ollama = providerReasoningCompat(
      createProvider({ id: 'ollama', apiHost: 'http://localhost:11434/v1', type: 'openai' }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(ollama).toBeUndefined()
    const poe = providerReasoningCompat(
      createProvider({ id: 'poe', apiHost: 'https://api.poe.com/v1', type: 'openai' }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(poe).toBeUndefined()
  })

  // ---- A 层：用户声明（最高优先） ----

  it('用户声明"不支持 enable_thinking" → 剥离推断协议，回落引擎探测', () => {
    // 纯 C 命中剥离后为空 → 完全不干预
    const plain = providerReasoningCompat(
      createProvider({
        id: 'my-gw',
        apiHost: 'https://gw.example.com/v1',
        type: 'openai',
        apiOptions: { isNotSupportEnableThinking: true }
      }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(plain).toBeUndefined()
    // 硅基流动：B 层 developer-role 修正存留，思考协议被剥离
    const silicon = providerReasoningCompat(
      createProvider({
        id: 'silicon',
        apiHost: '',
        type: 'openai',
        apiOptions: { isNotSupportEnableThinking: true }
      }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(silicon).toEqual({ supportsDeveloperRole: false })
  })

  it('显式 developer-role 声明覆盖一切：老数据迁移值 false / 用户拨 true 纠正网关事实', () => {
    // migrate 127/129/132 落在老自定义网关上的机器值（false）→ 恢复上游保守语义
    const migrated = providerReasoningCompat(
      createProvider({
        id: 'my-gw',
        apiHost: 'https://gw.example.com/v1',
        type: 'openai',
        apiOptions: { isSupportDeveloperRole: false }
      }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(migrated).toEqual({ ...QWEN_TRIO, supportsDeveloperRole: false })
    // 用户拨 true → 反向纠正登记事实（硅基流动某天支持了也无需改代码）
    const silicon = providerReasoningCompat(
      createProvider({
        id: 'silicon',
        apiHost: '',
        type: 'openai',
        apiOptions: { isSupportDeveloperRole: true }
      }),
      createModel('Pro/moonshotai/Kimi-K2.6')
    )
    expect(silicon).toEqual({ ...QWEN_TRIO, supportsDeveloperRole: true })
  })

  it('顶层旧旗标兜底：poe/qiniu 的 isNotSupportDeveloperRole 滞留值仍被接住', () => {
    const compat = providerReasoningCompat(
      createProvider({
        id: 'my-poe-mirror',
        apiHost: 'https://gw.example.com/v1',
        type: 'openai',
        isNotSupportDeveloperRole: true
      }),
      createModel('Qwen/Qwen3-8B')
    )
    expect(compat).toEqual({ ...QWEN_TRIO, supportsDeveloperRole: false })
  })

  it('全新自定义网关（未动过任何开关）× 非键族模型 → 完全不干预', () => {
    const compat = providerReasoningCompat(
      createProvider({ id: 'my-gw', apiHost: 'https://gw.example.com/v1', type: 'openai' }),
      createModel('gpt-5.2')
    )
    expect(compat).toBeUndefined()
  })
})
