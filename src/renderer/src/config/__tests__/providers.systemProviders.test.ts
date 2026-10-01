import { describe, expect, it } from 'vitest'

import { SYSTEM_PROVIDERS, SYSTEM_PROVIDERS_CONFIG } from '../providers'

/**
 * r2-81 行为契约：`SYSTEM_PROVIDERS` 必须是 `SYSTEM_PROVIDERS_CONFIG` 的**副本**。
 * 此前它就是 `Object.values(SYSTEM_PROVIDERS_CONFIG)`——同一批对象引用，
 * 于是 Redux 初始态与 `store/migrate.ts` 的就地改写（`provider.anthropicApiHost = …`、
 * `provider.type = 'openai-response'`）会污染模块级默认表。
 *
 * 取舍：多出 N 个 provider 浅拷贝 + N 个 models 数组（model 条目仍共享），
 * 换来默认表在本会话内不可被 state 改写。
 */
describe('SYSTEM_PROVIDERS isolation (r2-81)', () => {
  it('keeps the same export shape and ids', () => {
    expect(Array.isArray(SYSTEM_PROVIDERS)).toBe(true)
    expect(SYSTEM_PROVIDERS.length).toBe(Object.values(SYSTEM_PROVIDERS_CONFIG).length)
    expect(SYSTEM_PROVIDERS.map((p) => p.id).sort()).toEqual(
      Object.values(SYSTEM_PROVIDERS_CONFIG)
        .map((p) => p.id)
        .sort()
    )
  })

  it('does not share provider object identity with the module-level default table', () => {
    for (const provider of SYSTEM_PROVIDERS) {
      expect(provider).not.toBe(SYSTEM_PROVIDERS_CONFIG[provider.id])
    }
  })

  it('does not share the models array identity either', () => {
    for (const provider of SYSTEM_PROVIDERS) {
      const source = SYSTEM_PROVIDERS_CONFIG[provider.id]
      expect(provider.models).not.toBe(source.models)
      expect(provider.models).toEqual(source.models)
    }
  })

  it('keeps an in-place write on the exported array away from the default table', () => {
    const target = SYSTEM_PROVIDERS.find((p) => p.id === 'lmstudio')!
    const source = SYSTEM_PROVIDERS_CONFIG.lmstudio
    const original = source.anthropicApiHost

    target.anthropicApiHost = 'http://mutated-by-test:1'
    expect(source.anthropicApiHost).toBe(original)
  })
})
