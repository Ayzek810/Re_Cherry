import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `getProviderByModel` 的三值契约。
 *
 * 旧契约：查不到时静默回落到 `defaultProvider || providers[0]`，并声明返回 `Provider`——
 * 调用方无法区分「没有 provider」与「有 provider」，会把请求发到
 * 「外来 model.id + 别的 provider」的组合上。
 *
 * 新契约：查不到 ⇒ `undefined`；唯一实现是 `ProviderService.getProviderByModel`，
 * `AssistantService.getProviderByModel` 只转发同一函数。
 *
 * 本文件是反向对照的钉子：任一份实现改回带回落的版本、或 `AssistantService` 重新长出
 * 第二份实现，下列用例即转红（旧实现下第 2、4、6 例失败）。
 */

const getStoreProvidersMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/hooks/useStore', () => ({ getStoreProviders: getStoreProvidersMock }))

// 默认模型指向 `openai`：旧实现会把「未命中」静默换成 `openai`，新实现必须返回 `undefined`。
const defaultModel = vi.hoisted(
  () => ({ id: 'gpt-4o', name: 'gpt-4o', provider: 'openai', group: 'OpenAI' }) as unknown as Model
)
vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: {
    getState: () => ({ llm: { defaultModel, providers: [] } })
  }
}))

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

import {
  getDefaultProvider,
  getProviderByModel as getProviderByModelFromAssistantService
} from '@renderer/services/AssistantService'
import { getProviderByModel as getProviderByModelFromProviderService } from '@renderer/services/ProviderService'

const createProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'openai',
    type: 'openai',
    name: 'OpenAI',
    apiKey: '',
    apiHost: '',
    models: [],
    ...overrides
  }) as Provider

const openai = createProvider()
const anthropic = createProvider({ id: 'anthropic', type: 'anthropic', name: 'Anthropic' })

describe('getProviderByModel three-valued contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStoreProvidersMock.mockReturnValue([openai, anthropic])
  })

  it('returns the provider that matches model.provider', () => {
    const model = { id: 'claude-3.5-sonnet', provider: 'anthropic' } as Model

    expect(getProviderByModelFromAssistantService(model)).toBe(anthropic)
    expect(getProviderByModelFromProviderService(model)).toBe(anthropic)
  })

  it('returns undefined when no provider matches, even when the default provider exists', () => {
    // 关键回归：旧实现在这里回落到 `openai`（默认模型的 provider），把「没有」伪装成「有」。
    const model = { id: 'ghost-model', provider: 'deleted-provider' } as Model

    expect(getProviderByModelFromAssistantService(model)).toBeUndefined()
    expect(getProviderByModelFromProviderService(model)).toBeUndefined()
  })

  it('returns undefined when the model carries no provider id', () => {
    expect(getProviderByModelFromAssistantService(undefined)).toBeUndefined()
    expect(getProviderByModelFromAssistantService({ id: 'm' } as Model)).toBeUndefined()
  })

  it('returns undefined when the provider list is empty', () => {
    getStoreProvidersMock.mockReturnValue([])

    expect(getProviderByModelFromAssistantService({ id: 'gpt-4o', provider: 'openai' } as Model)).toBeUndefined()
  })

  it('exposes the same single implementation from both service modules', () => {
    // 去重钉子：两份实现曾经语义相反（一份纯查表、一份静默回落），因此只留一份。
    expect(getProviderByModelFromAssistantService).toBe(getProviderByModelFromProviderService)
  })

  it('getDefaultProvider returns undefined instead of falling back to providers[0]', () => {
    // 默认模型指向 `openai`，清单里只有 `anthropic`：旧实现返回 providers[0]（anthropic）。
    getStoreProvidersMock.mockReturnValue([anthropic])

    expect(getDefaultProvider()).toBeUndefined()
  })
})
