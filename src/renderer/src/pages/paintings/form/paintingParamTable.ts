/**
 * 绘画参数表（v0.3.3 批次4，fork 侧新写）：替代 V2 provider-registry 的 44 键
 * catalog——本地静态表驱动 form 字段与参数透传（约束 A：不引入 registry 包）。
 * 形状对齐 fork 既有 GenerateImageParams（types/index.ts L441-454）；键 = 透传
 * API 的 camelCase 名（lightGenerateImage 内部转 snake）。
 */
export interface PaintingParamSpec {
  key: string
  kind: 'textarea' | 'size' | 'number' | 'slider' | 'text'
  labelKey: string
  required?: boolean
  min?: number
  max?: number
  step?: number
  /** size 专用：预设尺寸 chips。 */
  sizes?: string[]
}

/** 基础参数（所有生图模型通用）。 */
export const PAINTING_BASE_PARAMS = [
  { key: 'prompt', kind: 'textarea', labelKey: 'paintings.param.prompt', required: true },
  {
    key: 'imageSize',
    kind: 'size',
    labelKey: 'paintings.param.size',
    required: true,
    sizes: ['1024x1024', '864x1152', '1152x864', '1280x800', '800x1280', '1440x720', '720x1440']
  },
  { key: 'batchSize', kind: 'slider', labelKey: 'paintings.param.batch_size', min: 1, max: 4, step: 1 }
] as const satisfies readonly PaintingParamSpec[]

/** 扩展参数（按模型能力透传；未设置的字段不下发）。 */
export const PAINTING_ADVANCED_PARAMS = [
  { key: 'negativePrompt', kind: 'textarea', labelKey: 'paintings.param.negative_prompt' },
  { key: 'seed', kind: 'text', labelKey: 'paintings.param.seed' },
  { key: 'numInferenceSteps', kind: 'slider', labelKey: 'paintings.param.num_inference_steps', min: 1, max: 50, step: 1 },
  { key: 'guidanceScale', kind: 'slider', labelKey: 'paintings.param.guidance_scale', min: 1, max: 20, step: 0.5 },
  { key: 'quality', kind: 'text', labelKey: 'paintings.param.quality' }
] as const satisfies readonly PaintingParamSpec[]

export const PAINTING_PARAM_TABLE: readonly PaintingParamSpec[] = [...PAINTING_BASE_PARAMS, ...PAINTING_ADVANCED_PARAMS]

/** 请求体只收本地表内键（V2 buildParamsSchema.safeParse 的本地等价）。 */
export function filterParamsByTable(params: Record<string, unknown>): Record<string, unknown> {
  const keys = new Set(PAINTING_PARAM_TABLE.map((spec) => spec.key))
  return Object.fromEntries(Object.entries(params).filter(([key]) => keys.has(key)))
}
