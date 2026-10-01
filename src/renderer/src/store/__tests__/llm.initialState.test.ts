import { describe, expect, it } from 'vitest'

// 注意 import 顺序：必须**先**引 `../llm`（应用入口先引 store，同序）。
// `config/models/websearch.ts` → `services/AssistantService` → store 这条链让
// `config/providers` 与 `store/llm` 成环；若先引 `config/providers`，llm.ts 在环内求值时
// 读到的还是未初始化的绑定，`initialState.providers` 会是 `[]`。config/providers 只在本文件
// 的用例体内动态引入，保证 llm.ts 先生成。
import llm, { initialState, updateProvider } from '../llm'

/**
 * `store/llm.ts` 的 `initialState.providers` 曾直接别名 `SYSTEM_PROVIDERS_CONFIG` 的值
 * （`Object.values(omit(...))` 是同一批模块对象）。迁移链会就地改写 provider
 * （`provider.type = 'openai-compatible'`、`provider.anthropicApiHost = …`），初始态共享引用
 * 就等于把模块默认表交给改写方，同会话内任何从 `initialState` 重建 llm 切片的路径都会拿到
 * 被污染过的默认值。这里钉住：初始态的 provider 元素与 models 数组都不是模块表对象。
 */
type ProviderLike = { id: string; apiHost?: string; models: Array<Record<string, unknown>> }

type ProviderConfig = Record<string, ProviderLike>

const loadConfig = async () => {
  const mod = await import('@renderer/config/providers')
  return {
    config: mod.SYSTEM_PROVIDERS_CONFIG as unknown as ProviderConfig,
    providers: mod.SYSTEM_PROVIDERS as unknown as ProviderLike[]
  }
}

describe('llm slice — initialState 不与 config 默认表共享对象', () => {
  it('每个 provider 元素与其 models 数组都是副本（值相等、引用不同）', async () => {
    const { config, providers: systemProviders } = await loadConfig()

    expect(initialState.providers.length).toBeGreaterThan(0)

    for (const provider of initialState.providers as unknown as ProviderLike[]) {
      const configured = config[provider.id]
      expect(configured).toBeDefined()
      expect(provider).not.toBe(configured)
      expect(provider.models).not.toBe(configured.models)
      expect(provider.models).toEqual(configured.models)
      expect(provider).toEqual(configured)
      // 取材表 SYSTEM_PROVIDERS 也已克隆（config/providers.ts cloneSystemProvider），三处互不同一
      expect(provider).not.toBe(systemProviders.find((candidate) => candidate.id === provider.id))
    }
  })

  it('updateProvider 的就地写语义不落到模块默认表上', async () => {
    const { config } = await loadConfig()
    const target = (initialState.providers as unknown as ProviderLike[])[0]
    const configured = config[target.id]
    const before = { ...configured, models: configured.models.map((model) => ({ ...model })) }

    const next = llm(undefined, updateProvider({ id: target.id, apiHost: 'https://example.invalid' }))

    expect(next.providers.find((provider) => provider.id === target.id)?.apiHost).toBe('https://example.invalid')
    expect({ ...configured, models: configured.models.map((model) => ({ ...model })) }).toEqual(before)
  })
})
