import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * r2-42：`ApiService` 的三个 `getProviderByModel` 调用点不再依赖静默回落。
 *
 * 旧行为：查不到 provider 时 `getProviderByModel` 回落到 `defaultProvider || providers[0]`，
 * 于是请求被发到「外来 model.id + 任意 provider」上——用户看到「无 API 密钥」之类的
 * 误导性错误；`fetchNoteSummary` 更把失败折成 `null` 之外什么也看不出。
 *
 * 新行为：查不到 ⇒ 走**显式的失败分支**（`{text: null, error}` 或 `null`），并且
 * **不发起任何内核调用**。旧实现下前两例转红（会调用 `lightComplete`）。
 */

const getProviderByModelMock = vi.hoisted(() => vi.fn())
const lightCompleteMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: getProviderByModelMock,
  getDefaultModel: vi.fn(() => ({ id: 'gpt-4o', provider: 'openai' })),
  getQuickModel: vi.fn(() => ({ id: 'gpt-4o', provider: 'openai' })),
  getDefaultAssistant: vi.fn(() => ({
    id: 'default',
    name: 'Default',
    prompt: '',
    settings: {},
    topics: [],
    messages: [],
    type: 'assistant'
  }))
}))

vi.mock('@renderer/services/lightLlm', () => ({ lightComplete: lightCompleteMock }))
vi.mock('@renderer/services/embedding', () => ({ getEmbeddingDimensions: vi.fn() }))
vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@renderer/hooks/useSettings', () => ({ getStoreSetting: vi.fn(() => undefined) }))
vi.mock('@renderer/config/models', () => ({ isEmbeddingModel: vi.fn(() => false) }))
vi.mock('@renderer/utils', () => ({
  formatApiHost: (host: string) => host,
  getDefaultGroupName: () => 'default',
  removeSpecialCharactersForTopicName: (name: string) => name
}))
vi.mock('@renderer/utils/error', () => ({ getErrorMessage: (error: unknown) => String(error) }))
vi.mock('@renderer/utils/markdown', () => ({ purifyMarkdownImages: (text: string) => text }))
vi.mock('@renderer/utils/messageUtils/find', () => ({
  findFileBlocks: () => [],
  findImageBlocks: () => [],
  getMainTextContent: () => ''
}))
vi.mock('@renderer/utils/prompt', () => ({
  containsSupportedVariables: () => false,
  replacePromptVariables: async (prompt: string) => prompt
}))
vi.mock('@renderer/utils/provider', () => ({
  isAnthropicProvider: () => false,
  isOllamaProvider: () => false,
  NOT_SUPPORT_API_KEY_PROVIDER_TYPES: [],
  NOT_SUPPORT_API_KEY_PROVIDERS: []
}))

import { fetchGenerate, fetchMessagesSummary, fetchNoteSummary } from '@renderer/services/ApiService'

const ghostModel = { id: 'ghost-model', provider: 'deleted-provider' } as Model

const liveProvider = {
  id: 'openai',
  type: 'openai',
  name: 'OpenAI',
  apiKey: 'sk-test',
  apiHost: 'https://api.example.com',
  models: []
} as Provider

describe('ApiService provider lookup failures (r2-42)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lightCompleteMock.mockResolvedValue({ text: 'ok' })
  })

  it('fetchMessagesSummary reports the missing provider and never calls the model', async () => {
    getProviderByModelMock.mockReturnValue(undefined)

    await expect(fetchMessagesSummary({ messages: [] })).resolves.toEqual({
      text: null,
      error: 'error.provider_not_found'
    })
    expect(lightCompleteMock).not.toHaveBeenCalled()
  })

  it('fetchGenerate reports the missing provider instead of a fake empty answer', async () => {
    getProviderByModelMock.mockReturnValue(undefined)

    await expect(fetchGenerate({ prompt: 'p', content: 'c', model: ghostModel })).resolves.toEqual({
      text: null,
      error: 'error.provider_not_found'
    })
    expect(lightCompleteMock).not.toHaveBeenCalled()
  })

  it('fetchNoteSummary returns null on a missing provider (the note page shows a failure toast)', async () => {
    getProviderByModelMock.mockReturnValue(undefined)

    await expect(fetchNoteSummary({ content: 'c' })).resolves.toBeNull()
    expect(lightCompleteMock).not.toHaveBeenCalled()
  })

  it('still calls the model when a provider with a key matches', async () => {
    getProviderByModelMock.mockReturnValue(liveProvider)

    await expect(fetchGenerate({ prompt: 'p', content: 'c', model: ghostModel })).resolves.toEqual({ text: 'ok' })
    expect(lightCompleteMock).toHaveBeenCalledTimes(1)
  })
})
