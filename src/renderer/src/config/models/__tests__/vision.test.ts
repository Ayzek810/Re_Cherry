import type { Model } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isEmbeddingModel, isRerankModel } from '../embedding'
import {
  isAutoEnableImageGenerationModel,
  isChatCandidateModel,
  isGenerateImageModel,
  isTextToImageModel,
  isVisionModel
} from '../vision'

vi.mock('@renderer/hooks/useStore', () => ({
  getStoreProviders: vi.fn(() => [])
}))

vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: {
    getState: () => ({
      llm: { providers: [] },
      settings: {}
    })
  },
  useAppDispatch: vi.fn(),
  useAppSelector: vi.fn()
}))

vi.mock('@renderer/store/settings', () => {
  const noop = vi.fn()
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'initialState') {
          return {}
        }
        return noop
      }
    }
  )
})

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: vi.fn(() => ({})),
  useNavbarPosition: vi.fn(() => ({ navbarPosition: 'left' })),
  useMessageStyle: vi.fn(() => ({ isBubbleStyle: false })),
  getStoreSetting: vi.fn()
}))

vi.mock('../embedding', () => ({
  isEmbeddingModel: vi.fn(),
  isRerankModel: vi.fn()
}))

const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'gpt-4o',
  name: 'gpt-4o',
  provider: 'openai',
  group: 'OpenAI',
  ...overrides
})

const embeddingMock = vi.mocked(isEmbeddingModel)
const rerankMock = vi.mocked(isRerankModel)

describe('vision helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embeddingMock.mockReturnValue(false)
    rerankMock.mockReturnValue(false)
  })

  describe('isGenerateImageModel (宽语义：生图场景唯一判据)', () => {
    it('returns false for embedding/rerank models', () => {
      embeddingMock.mockReturnValueOnce(true)
      expect(isGenerateImageModel(createModel({ id: 'dall-e-3' }))).toBe(false)

      embeddingMock.mockReturnValue(false)
      rerankMock.mockReturnValueOnce(true)
      expect(isGenerateImageModel(createModel({ id: 'dall-e-3' }))).toBe(false)
    })

    it('honours the user override in both directions, ahead of all data', () => {
      // 手选 true：目录里没有的模型也成立（编辑弹窗那枚开关写的就是它）
      expect(
        isGenerateImageModel(
          createModel({ id: 'gpt-4o', capabilities: [{ type: 'image_generation', isUserSelected: true }] })
        )
      ).toBe(true)
      // 手选 false：目录命中的模型也被否决
      expect(
        isGenerateImageModel(
          createModel({
            id: 'dall-e-3',
            capabilities: [{ type: 'image_generation', isUserSelected: false }]
          })
        )
      ).toBe(false)
    })

    it('trusts an image-generation endpoint declaration', () => {
      expect(
        isGenerateImageModel(createModel({ id: 'local-sd', provider: 'custom', endpoint_type: 'image-generation' }))
      ).toBe(true)
      expect(
        isGenerateImageModel(
          createModel({ id: 'local-sd', provider: 'custom', supported_endpoint_types: ['image-generation'] })
        )
      ).toBe(true)
    })

    it('reads the ported V2 registry catalog', () => {
      expect(isGenerateImageModel(createModel({ id: 'dall-e-3', provider: 'openai' }))).toBe(true)
      expect(isGenerateImageModel(createModel({ id: 'gpt-image-1', provider: 'openai' }))).toBe(true)
      expect(isGenerateImageModel(createModel({ id: 'cogview-4', provider: 'zhipu' }))).toBe(true)
      expect(isGenerateImageModel(createModel({ id: 'gemini-2-5-flash-image', provider: 'openrouter' }))).toBe(true)
    })

    it('falls back to no id list at all (chat models stay chat models)', () => {
      expect(isGenerateImageModel(createModel({ id: 'gpt-4o' }))).toBe(false)
      expect(isGenerateImageModel(createModel({ id: 'gpt-4o-mini' }))).toBe(false)
      expect(isGenerateImageModel(createModel({ id: 'o3' }))).toBe(false)
      expect(isGenerateImageModel(createModel({ id: 'midjourney-v6' }))).toBe(false)
      expect(isGenerateImageModel(createModel({ id: 'gemini-2.5-flash' }))).toBe(false)
    })
  })

  describe('isTextToImageModel (窄语义：V2 IMAGE_GENERATION && !REASONING)', () => {
    it('accepts dedicated text-to-image models', () => {
      expect(isTextToImageModel(createModel({ id: 'dall-e-3', provider: 'openai' }))).toBe(true)
      expect(isTextToImageModel(createModel({ id: 'gpt-image-1', provider: 'openai' }))).toBe(true)
      expect(isTextToImageModel(createModel({ id: 'cogview-4', provider: 'zhipu' }))).toBe(true)
    })

    it('rejects image models that also carry reasoning in the registry', () => {
      expect(isTextToImageModel(createModel({ id: 'gemini-2-5-flash-image', provider: 'openrouter' }))).toBe(false)
      expect(isTextToImageModel(createModel({ id: 'gpt-5-image', provider: 'openrouter' }))).toBe(false)
    })

    it('rejects anything that is not an image model at all', () => {
      expect(isTextToImageModel(createModel({ id: 'gpt-4o' }))).toBe(false)
      // 名字像生图模型但没有数据依据：不再有名单兜底
      expect(isTextToImageModel(createModel({ id: 'midjourney-v6' }))).toBe(false)
    })

    it('treats a user-marked model without registry reasoning as text-to-image', () => {
      expect(
        isTextToImageModel(
          createModel({ id: 'gpt-4o', capabilities: [{ type: 'image_generation', isUserSelected: true }] })
        )
      ).toBe(true)
    })
  })

  describe('isChatCandidateModel', () => {
    it('is the negation of the image judgement', () => {
      expect(isChatCandidateModel(createModel({ id: 'gpt-4o' }))).toBe(true)
      expect(isChatCandidateModel(createModel({ id: 'dall-e-3', provider: 'openai' }))).toBe(false)

      embeddingMock.mockReturnValueOnce(true)
      expect(isChatCandidateModel(createModel({ id: 'gpt-4o' }))).toBe(false)
    })
  })

  describe('text-to-image helpers', () => {
    it('auto-enables image generation for supported models', () => {
      expect(isAutoEnableImageGenerationModel(createModel({ id: 'gemini-2.5-flash-image-ultra' }))).toBe(true)
    })

    it('returns false when models are not in the auto-enable set', () => {
      expect(isAutoEnableImageGenerationModel(createModel({ id: 'gpt-4o' }))).toBe(false)
    })
  })
})

describe('isVisionModel', () => {
  it('returns false for embedding/rerank models and honors overrides', () => {
    embeddingMock.mockReturnValueOnce(true)
    expect(isVisionModel(createModel({ id: 'gpt-4o' }))).toBe(false)

    embeddingMock.mockReturnValue(false)
    const disabled = createModel({
      id: 'gpt-4o',
      capabilities: [{ type: 'vision', isUserSelected: false }]
    })
    expect(isVisionModel(disabled)).toBe(false)

    const forced = createModel({
      id: 'gpt-4o',
      capabilities: [{ type: 'vision', isUserSelected: true }]
    })
    expect(isVisionModel(forced)).toBe(true)
  })

  it('matches doubao models by name and general regexes by id', () => {
    const doubao = createModel({
      id: 'custom-id',
      provider: 'doubao',
      name: 'Doubao-Seed-1-6-Lite-251015'
    })
    expect(isVisionModel(doubao)).toBe(true)

    expect(isVisionModel(createModel({ id: 'gpt-4o-mini' }))).toBe(true)
  })

  it('matches MiniMax M3 as vision but not text-only M2.x', () => {
    expect(isVisionModel(createModel({ id: 'MiniMax-M3', provider: 'minimax' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'MiniMax-M2.7', provider: 'minimax' }))).toBe(false)
  })

  it('leverages image enhancement regex when standard vision regex does not match', () => {
    expect(isVisionModel(createModel({ id: 'qwen-image-edit' }))).toBe(true)
  })

  it('returns false for doubao models that fail regex checks', () => {
    const doubao = createModel({ id: 'doubao-standard', provider: 'doubao', name: 'basic' })
    expect(isVisionModel(doubao)).toBe(false)
  })

  describe('Gemini Models', () => {
    it('should return true for gemini 1.5 models', () => {
      expect(
        isVisionModel({
          id: 'gemini-1.5-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-1.5-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini 2.x models', () => {
      expect(
        isVisionModel({
          id: 'gemini-2.0-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-2.0-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-2.5-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-2.5-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini latest models', () => {
      expect(
        isVisionModel({
          id: 'gemini-flash-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-pro-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-flash-lite-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini 3 models', () => {
      // Preview versions
      expect(
        isVisionModel({
          id: 'gemini-3-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Future stable versions
      expect(
        isVisionModel({
          id: 'gemini-3-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-3-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini 3.1 models', () => {
      // Preview versions
      expect(
        isVisionModel({
          id: 'gemini-3.1-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Stable versions
      expect(
        isVisionModel({
          id: 'gemini-3.1-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isVisionModel({
          id: 'gemini-3.1-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini exp models', () => {
      expect(
        isVisionModel({
          id: 'gemini-exp-1206',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return false for gemini 1.0 models', () => {
      expect(
        isVisionModel({
          id: 'gemini-1.0-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })
  })

  describe('Kimi Models', () => {
    it('should return true for kimi models', () => {
      expect(isVisionModel(createModel({ id: 'kimi-k2.5' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'moonshot/kimi-k2.5' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'kimi-k2.6' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'moonshot/kimi-k2.6' }))).toBe(true)
    })
    it('should return false for kimi non-vision models', () => {
      expect(isVisionModel(createModel({ id: 'kimi-k2-thinking' }))).toBe(false)
    })
  })

  describe('MiMo Models', () => {
    it('should identify only the full-modal V2.5 chat model as vision-capable', () => {
      expect(isVisionModel(createModel({ id: 'mimo-v2.5' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'xiaomi/mimo-v2.5' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'mimo-v2.5-pro' }))).toBe(false)
      expect(isVisionModel(createModel({ id: 'mimo-v2.5-tts' }))).toBe(false)
    })
  })

  describe('Qwen Models', () => {
    it('should return true for Qwen vision models', () => {
      expect(isVisionModel(createModel({ id: 'qwen-vl-max' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'qwen3-vl' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'qwen3.5-plus' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'qwen3.5-plus-2026-02-15' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'qwen3.5-397b-a17b' }))).toBe(true)
    })

    it('should return false for Qwen max series models (non-vision)', () => {
      expect(isVisionModel(createModel({ id: 'qwen3.7-max' }))).toBe(false)
      expect(isVisionModel(createModel({ id: 'qwen-max' }))).toBe(false)
      expect(isVisionModel(createModel({ id: 'qwen3.5-max' }))).toBe(false)
    })

    it('should return true for Qwen VL series with max suffix', () => {
      expect(isVisionModel(createModel({ id: 'qwen-vl-max' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'qwen2-vl-max' }))).toBe(true)
      expect(isVisionModel(createModel({ id: 'qwen3-vl-max' }))).toBe(true)
    })
  })
})

describe('Doubao Seed 2.0 Models', () => {
  it('should identify doubao-seed-2-0-pro-260215 as vision model', () => {
    const model: Model = {
      id: 'doubao-seed-2-0-pro-260215',
      name: 'doubao-seed-2-0-pro',
      provider: 'doubao',
      group: 'Doubao-Seed-2.0'
    }
    expect(isVisionModel(model)).toBe(true)
  })

  it('should identify doubao-seed-2-0-lite-260215 as vision model', () => {
    const model: Model = {
      id: 'doubao-seed-2-0-lite-260215',
      name: 'doubao-seed-2-0-lite',
      provider: 'doubao',
      group: 'Doubao-Seed-2.0'
    }
    expect(isVisionModel(model)).toBe(true)
  })

  it('should identify doubao-seed-2-0-code-preview-260215 as vision model', () => {
    const model: Model = {
      id: 'doubao-seed-2-0-code-preview-260215',
      name: 'doubao-seed-2-0-code-preview',
      provider: 'doubao',
      group: 'Doubao-Seed-2.0'
    }
    expect(isVisionModel(model)).toBe(true)
  })

  it('should identify doubao-seed-2-0-mini-260215 as vision model', () => {
    const model: Model = {
      id: 'doubao-seed-2-0-mini-260215',
      name: 'doubao-seed-2-0-mini',
      provider: 'doubao',
      group: 'Doubao-Seed-2.0'
    }
    expect(isVisionModel(model)).toBe(true)
  })

  it('should identify doubao-seed-2.0 models by provider and name', () => {
    const model: Model = {
      id: 'custom-id',
      name: 'doubao-seed-2.0-pro-260215',
      provider: 'doubao',
      group: 'Doubao-Seed-2.0'
    }
    expect(isVisionModel(model)).toBe(true)
  })
})

describe('Gemma 4 Models', () => {
  it('detects Gemma 4 GenAI format as vision', () => {
    expect(isVisionModel(createModel({ id: 'gemma-4-e2b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma-4-e4b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma-4-26b-moe' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma-4-31b' }))).toBe(true)
  })

  it('detects Gemma 4 Ollama format as vision', () => {
    expect(isVisionModel(createModel({ id: 'gemma4' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma4:e2b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma4:31b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma4:latest' }))).toBe(true)
  })

  it('detects Gemma 4 with provider prefix', () => {
    expect(isVisionModel(createModel({ id: 'google/gemma-4-31b' }))).toBe(true)
  })

  it('still detects Gemma 3 as vision (no regression)', () => {
    expect(isVisionModel(createModel({ id: 'gemma-3-27b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma-3-4b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma3' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'gemma3:latest' }))).toBe(true)
  })

  it('does NOT detect Gemma 2 as vision (no regression)', () => {
    expect(isVisionModel(createModel({ id: 'gemma-2b' }))).toBe(false)
    expect(isVisionModel(createModel({ id: 'gemma-2-27b-it' }))).toBe(false)
  })
})

describe('Mistral Models', () => {
  // Regression test for mistral-small-2603 vision support (broken in previous implementation)
  it('should return true for mistral-small-2603', () => {
    expect(isVisionModel(createModel({ id: 'mistral-small-2603' }))).toBe(true)
  })

  it('should return true for mistral-small-2603 with provider prefix', () => {
    expect(isVisionModel(createModel({ id: 'mistralai/mistral-small-2603' }))).toBe(true)
  })

  // Regression check for existing mistral-small variants
  it('should return true for mistral-small-latest', () => {
    expect(isVisionModel(createModel({ id: 'mistral-small-latest' }))).toBe(true)
  })

  it('should return true for mistral-small-2506', () => {
    expect(isVisionModel(createModel({ id: 'mistral-small-2506' }))).toBe(true)
  })

  // Regression check for pixtral models (dedicated vision models)
  it('should return true for pixtral models', () => {
    expect(isVisionModel(createModel({ id: 'pixtral-12b' }))).toBe(true)
    expect(isVisionModel(createModel({ id: 'pixtral-large' }))).toBe(true)
  })
})
