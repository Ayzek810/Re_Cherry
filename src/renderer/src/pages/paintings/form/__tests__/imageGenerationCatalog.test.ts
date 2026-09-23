/**
 * 目录解析 + 字段映射 + 参数校验机测（v0.3.3 批次6，V2 绘画参数来源移植）。
 *
 * 断言的是**契约**，不是实现快照：
 *   · 解析序 = V2 `getImageGenerationSupport`（provider override 优先于 creator 默认）；
 *   · 范围外 provider/模型 = null（调用方据此给明错，不静默）；
 *   · `imageGenerationToFields` 的字段面 = 该模型声明的键（看得见 = 真会下发）；
 *   · `buildParamsSchema` 的 coerce/约束语义 = V2 zod 版（blank→omit、越界→omit、未知键保留）。
 */
import {
  buildParamsSchema,
  CANONICAL_PARAM_KEYS,
  getImageGenerationCatalogEntry,
  getImageGenerationSupport,
  IMAGE_WIRE_PROFILES,
  isOffPlaneVendor,
  normalizeAspectRatio,
  OFF_PLANE_VENDOR_IDS,
  resolveImageGenerationSupport,
  resolveImageWireProfile,
  wireName
} from '@shared/lightLlm/imageGenerationCatalog'
import { describe, expect, it } from 'vitest'

import { imageGenerationToFields } from '../imageGenerationToFields'

/** V2 `imageGenerationToFields` 的 mode 解析：请求的 mode，缺席回落到第一个声明的 mode。 */
const keysOf = (providerId: string, modelId: string, mode: 'generate' | 'edit' = 'generate'): string[] => {
  const modes = getImageGenerationSupport(providerId, modelId)?.modes
  if (!modes) return []
  const first = Object.keys(modes)[0] as 'generate' | 'edit' | undefined
  const supports = modes[mode]?.supports ?? (first ? modes[first]?.supports : undefined)
  return Object.keys(supports ?? {}).sort()
}

/** 字段的 option 值列表（`options` 既可能是静态数组也可能是函数，统一解析后取 value）。 */
const optionValues = (item: { options?: unknown }): Array<string | number | undefined> => {
  const options = typeof item.options === 'function' ? item.options(item as never, {}) : (item.options ?? [])
  return (options as Array<{ value?: string | number }>).map((option) => option.value)
}

describe('getImageGenerationSupport — 解析序与范围', () => {
  it('provider override 优先于 creator 默认（同一 modelId 两种块）', () => {
    // zhipu/cogview-4：provider override 带 addWatermark、无 negativePrompt/seed；
    // creator 默认带 negativePrompt/seed、无 addWatermark。解析结果必须是前者。
    const provider = getImageGenerationCatalogEntry('zhipu', 'cogview-4')
    expect(provider?.provenance.source).toBe('provider')
    expect(provider?.provenance.file).toContain('providers/zhipu.ts')
    expect(keysOf('zhipu', 'cogview-4')).toEqual(['addWatermark', 'numImages', 'quality', 'size'])

    const creator = getImageGenerationCatalogEntry('openai', 'dall-e-3')
    expect(creator?.provenance.source).toBe('creator')
    expect(creator?.provenance.file).toContain('creators/openai.ts')
    expect(keysOf('openai', 'dall-e-3')).toEqual(['quality', 'size', 'style'])
    // creator 默认确实不同（若解析序反了，这条就会以 creator 的键面出现在上面）
    expect(getImageGenerationCatalogEntry('zhipu', 'glm-image')?.provenance.source).toBe('provider')
  })

  it('creator 默认作为 provider override 缺席时的兜底（flux 家族只在 creators 里声明）', () => {
    const entry = getImageGenerationCatalogEntry('black-forest-labs', 'flux-2-pro')
    expect(entry?.provenance.source).toBe('creator')
    expect(keysOf('black-forest-labs', 'flux-2-pro')).toEqual(['aspectRatio', 'safetyTolerance', 'seed'])
  })

  it('范围外 provider / 未知模型 = null（绝不返回空 support 假装支持）', () => {
    for (const [provider, model] of [
      ['dashscope', 'qwen-image'],
      ['ppio', 'qwen-image'],
      ['aihubmix', 'flux-2-pro'],
      ['tokenhub', 'hy-image-lite'],
      ['ollama', 'x/z-image-turbo'],
      ['minimax', 'image-01'],
      ['google', 'imagen-4'],
      ['doubao', 'doubao-seedream-4-0'],
      ['openrouter', 'not-a-real-model'],
      ['openai', 'gpt-4o'],
      [undefined, undefined]
    ] as Array<[string | undefined, string | undefined]>) {
      expect(getImageGenerationSupport(provider, model)).toBeNull()
    }
  })

  it('dmxapi 走 /v1/images/generations 的 8 条在范围内；带 vendorTransport 的 4 条在范围外', () => {
    for (const model of [
      'dall-e-3',
      'doubao-seedream-4-0',
      'doubao-seedream-4-5',
      'gemini-2-5-flash-image',
      'gpt-image-1-5',
      'musesteamer-air-image',
      'nano-banana',
      'nano-banana-2'
    ]) {
      expect(getImageGenerationSupport('dmxapi', model), model).not.toBeNull()
    }
    for (const model of ['doubao-seedream-5-0-lite', 'gemini-3-1-flash-image-preview', 'qwen-image', 'wan2-6-t2i']) {
      expect(getImageGenerationSupport('dmxapi', model), model).toBeNull()
    }
  })

  it('多 mode 模型：edit/generate 各自的键面都取得到（openrouter flux 双 mode 同键）', () => {
    expect(keysOf('openrouter', 'flux-2-pro', 'generate')).toEqual(['aspectRatio', 'numImages', 'outputFormat', 'seed'])
    expect(keysOf('openrouter', 'flux-2-pro', 'edit')).toEqual(['aspectRatio', 'numImages', 'outputFormat', 'seed'])
    // openai gpt-image-1 的 edit 与 generate 同键面；dall-e-2 只有 generate
    expect(keysOf('openai', 'gpt-image-1')).toEqual(['background', 'moderation', 'numImages', 'quality', 'size'])
    expect(getImageGenerationSupport('openai', 'dall-e-2')?.modes.edit).toBeUndefined()
  })
})

describe('imageGenerationToFields — 字段面随模型能力', () => {
  it('openrouter/flux-2-pro → aspectRatio(aspect 枚举) + numImages + outputFormat + seed', () => {
    const items = imageGenerationToFields(getImageGenerationSupport('openrouter', 'flux-2-pro') ?? undefined, {
      mode: 'generate'
    })
    expect(items.map((item) => item.key)).toEqual(['aspectRatio', 'numImages', 'outputFormat', 'seed'])
    // V2 数据里 openrouter 的 aspectRatio 是「无 render 的 enum」= 下拉；与 openai 的 size chips 不同。
    expect(items[0]?.type).toBe('select')
    expect(optionValues(items[0] ?? {})).toEqual(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', 'auto'])
    expect(items[1]?.type).toBe('slider')
    expect(items[1]?.min).toBe(1)
    // openrouter 的 numImages 是 V2 的 `RangeIntSpecSchema` 单值档（min=max=1，step=1）
    expect(items[1]?.max).toBe(1)
    expect(items[1]?.tooltip).toBe('paintings.number_images_tip')
    expect(optionValues(items[2] ?? {})).toEqual(['png', 'jpeg'])
    expect(items[3]?.type).toBe('input')
  })

  it('openai/gpt-image-1 → background/moderation enum + quality + size chips', () => {
    const items = imageGenerationToFields(getImageGenerationSupport('openai', 'gpt-image-1') ?? undefined, {
      mode: 'generate'
    })
    expect(items.map((item) => item.key)).toEqual(['background', 'moderation', 'numImages', 'quality', 'size'])
    expect(items.map((item) => item.type)).toEqual(['select', 'select', 'slider', 'select', 'sizeChips'])
  })

  it('范围外/无 support → 空字段面（调用方据此不给生成入口，而不是给一堆无效控件）', () => {
    expect(imageGenerationToFields(undefined, { mode: 'generate' })).toEqual([])
    expect(
      imageGenerationToFields(getImageGenerationSupport('dashscope', 'qwen-image') ?? undefined, { mode: 'generate' })
    ).toEqual([])
  })

  it('mode 缺席时回落到模型声明的第一个 mode（V2 语义）', () => {
    const support = getImageGenerationSupport('dmxapi', 'nano-banana-2')
    expect(support?.modes.generate).toBeUndefined()
    expect(Object.keys(support?.modes ?? {})).toEqual(['edit', 'merge'])
    // nano-banana-2 只声明 edit/merge，请求 generate 也要渲染出已声明 mode 的字段面
    const items = imageGenerationToFields(support ?? undefined, { mode: 'generate' })
    expect(items.map((item) => item.key)).toEqual(['aspectRatio', 'numImages'])
  })
})

describe('buildParamsSchema — V2 校验/强制转换语义', () => {
  const parse = (providerId: string, modelId: string, params: Record<string, unknown>) =>
    buildParamsSchema(getImageGenerationSupport(providerId, modelId) ?? undefined, 'generate')(params)

  it('按 catalog 类型强制转换：seed 文本→int、numImages 文本→int、空白→省略', () => {
    expect(parse('silicon', 'x', { seed: '42', numImages: '3' })).toEqual({ seed: 42, numImages: 3 })
    expect(parse('silicon', 'x', { seed: '', numImages: '' })).toEqual({})
    expect(parse('silicon', 'x', { seed: 'not-a-number' })).toEqual({})
  })

  it('enum 越界 → 省略（不报错）；enum 合法值保留', () => {
    expect(parse('openai', 'dall-e-3', { quality: 'hd', style: 'vivid', size: '1024x1024' })).toEqual({
      quality: 'hd',
      style: 'vivid',
      size: '1024x1024'
    })
    expect(parse('openai', 'dall-e-3', { quality: 'ultra' })).toEqual({})
    expect(parse('openai', 'dall-e-3', { style: 'nope' })).toEqual({})
  })

  it('range 越界 → 省略；非整数 range 值取整（V2 numImages 是 int）', () => {
    expect(parse('openai', 'gpt-image-1', { numImages: 3 })).toEqual({ numImages: 3 })
    expect(parse('openai', 'gpt-image-1', { numImages: 99 })).toEqual({})
    expect(parse('openai', 'gpt-image-1', { numImages: 2.7 })).toEqual({ numImages: 2 })
  })

  it('未知/非 canonical 键原样保留（v2 `.loose()` + `.catch` 语义，供旧数据兼容层处理）', () => {
    expect(parse('openai', 'dall-e-3', { imageSize: '512x512', mystery: 1 })).toEqual({
      imageSize: '512x512',
      mystery: 1
    })
  })

  it('无 support（范围外）时仍按 catalog 类型 coerce，不做 enum/range 约束', () => {
    expect(buildParamsSchema(undefined, 'generate')({ seed: '7', quality: 'anything' })).toEqual({
      seed: 7,
      quality: 'anything'
    })
  })

  it('canonical 键表覆盖 44 键（v2 CANONICAL_PARAM_KEY）', () => {
    expect(CANONICAL_PARAM_KEYS).toHaveLength(44)
    expect(new Set(CANONICAL_PARAM_KEYS).size).toBe(44)
  })
})

describe('wire 映射表（canonical → vendor wire）', () => {
  it('wireName：默认 camelCase→snake_case，仅两个不规则覆盖（V2 IMAGE_PARAM_CATALOG.wire）', () => {
    expect(wireName('numInferenceSteps')).toBe('num_inference_steps')
    expect(wireName('guidanceScale')).toBe('guidance_scale')
    expect(wireName('aspectRatio')).toBe('aspect_ratio')
    expect(wireName('addWatermark')).toBe('watermark')
    expect(wireName('imageResolution')).toBe('size')
    expect(wireName('quality')).toBe('quality')
  })

  it('normalizeAspectRatio：ASPECT_16_9 → 16:9，非法值 → undefined（V2 同）', () => {
    expect(normalizeAspectRatio('ASPECT_16_9')).toBe('16:9')
    expect(normalizeAspectRatio('16:9')).toBe('16:9')
    expect(normalizeAspectRatio('weird')).toBeUndefined()
    expect(normalizeAspectRatio('')).toBeUndefined()
    expect(normalizeAspectRatio(16)).toBeUndefined()
  })

  it('wire profile 登记表：范围内 provider 有 profile，范围外为 undefined', () => {
    for (const provider of ['openai', 'openrouter', 'dmxapi', 'zhipu', 'silicon']) {
      expect(resolveImageWireProfile(provider), provider).toBeDefined()
    }
    for (const provider of ['dashscope', 'ppio', 'aihubmix', 'tokenhub', 'ollama', 'minimax', 'google', 'doubao']) {
      expect(resolveImageWireProfile(provider), provider).toBeUndefined()
    }
    expect(IMAGE_WIRE_PROFILES.diffusion).toBeDefined()
  })
})

describe('resolveImageGenerationSupport — 目录未收录时的通用兜底（fork 缝 v0.3.3-9）', () => {
  it('未收录的 (provider, model) 给通用字段面，而不是空（否则参数入口整块消失）', () => {
    for (const [provider, model] of [
      ['custom-openai', 'my-image-model'],
      ['openai', 'gpt-4o'],
      ['silicon', 'z-image-turbo']
    ] as Array<[string, string]>) {
      const { support, source } = resolveImageGenerationSupport(provider, model)
      expect(source, provider).toBe('generic')
      const keys = Object.keys(support?.modes.generate?.supports ?? {})
      expect(keys, provider).toContain('size')
      expect(keys, provider).toContain('numImages')
      expect(imageGenerationToFields(support, { mode: 'generate' }).length, provider).toBeGreaterThan(0)
    }
  })

  it('兜底字段面严格落在该 provider 的 wire profile 转发面内（看得见 = 真下发）', () => {
    const diffusionKeys = Object.keys(
      resolveImageGenerationSupport('custom-openai', 'm').support?.modes.generate?.supports ?? {}
    )
    for (const key of diffusionKeys) {
      // size / numImages 是本平面的原生化字段（NATIVE_BINDINGS），任何 profile 都下发
      if (key === 'size' || key === 'numImages') continue
      expect(IMAGE_WIRE_PROFILES.diffusion.forward, key).toContain(key)
    }
    // openai 档不转发 seed / negativePrompt → 兜底面也不得出现它们（否则又是静默丢弃）
    const openaiKeys = Object.keys(
      resolveImageGenerationSupport('openai', 'gpt-4o').support?.modes.generate?.supports ?? {}
    )
    expect(openaiKeys).not.toContain('seed')
    expect(openaiKeys).not.toContain('negativePrompt')
    expect(openaiKeys).toContain('quality')
  })

  it('厂商明确不在本平面 → 无字段面（与主进程明错一致）', () => {
    for (const provider of OFF_PLANE_VENDOR_IDS) {
      const resolved = resolveImageGenerationSupport(provider, 'm')
      expect(resolved.source, provider).toBe('off-plane')
      expect(resolved.support, provider).toBeUndefined()
      expect(imageGenerationToFields(resolved.support), provider).toEqual([])
      expect(isOffPlaneVendor(provider), provider).toBe(true)
    }
  })

  it('doubao（火山 Ark）与自建 provider 走兜底而不是被误杀（v0.3.3-9 修正）', () => {
    // Ark 的图像接口就是 {base}/images/generations（base 带 /api/v3），此前被当"范围外"拒绝
    for (const provider of ['doubao', 'my-custom-endpoint', 'silicon']) {
      expect(isOffPlaneVendor(provider), provider).toBe(false)
      expect(resolveImageGenerationSupport(provider, 'seedream-4-0').source, provider).toBe('generic')
    }
  })

  it('目录命中时 source = catalog（不改已有行为）', () => {
    const resolved = resolveImageGenerationSupport('openai', 'dall-e-3')
    expect(resolved.source).toBe('catalog')
    expect(Object.keys(resolved.support?.modes.generate?.supports ?? {}).sort()).toEqual(['quality', 'size', 'style'])
  })
})
