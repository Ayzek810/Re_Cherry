import {
  isDeepSeekHybridInferenceModel,
  isSupportedThinkingTokenKimiModel,
  isSupportedThinkingTokenQwenModel,
  isSupportedThinkingTokenZhipuModel
} from '@renderer/config/models'
import type { Model } from '@renderer/types'

/**
 * 第三方 OpenAI 兼容网关的思考协议修正 —— 三层解析（泛用解）。
 *
 * 背景：pi-ai 按内置名单自动识别网关（deepseek.com / openrouter / z.ai / together /
 * moonshot / nvidia / ant-ling / xai / cerebras / chutes / cloudflare 等，见其
 * detectCompat），名单外的网关（硅基流动、DashScope 兼容层、魔搭、各种中转）一律按
 * openai 格式直发 reasoning_effort——而 enable_thinking 家族模型（Qwen3 / Kimi K2.5+ /
 * DeepSeek 混合 / GLM）在这类聚合网关上的通用约定是 enable_thinking 布尔开关，
 * reasoning_effort 只在极少数模型上被认（硅基流动上仅 V4/V4-Flash/GLM-5.2 且只认
 * high/max）。不修正 = 档位静默失效 + "关"关不掉。
 *
 * 解析顺序（后者覆盖/剥离前者）：
 *   B. 已登记网关事实（REASONING_PROVIDER_RULES）—— 文档背书的网关级修正
 *      （如硅基流动不认 role: "developer"）。只管网关级事实；思考协议已泛用化。
 *   C. 家族语义推断（泛用）—— pi-ai 探测不到的 OpenAI 兼容网关 × enable_thinking
 *      家族 → qwen 格式。任何没被引擎认出的网关都自动获得正确协议，无需登记。
 *   A. 用户声明（最高优先）—— provider 设置里的既有开关逐 provider 纠偏：
 *      "enable_thinking 参数"关 → 剥离 C 层协议（回落引擎探测）；
 *      "developer role"显式开/关 → 覆盖 B 层。
 *
 * 引擎自己认得的网关（见 PI_AI_DETECTED_HOSTS）上 C 层不介入——那里的协议判断
 * 属于引擎领域；家族模型 + 无名网关才是 C 层的辖区。
 */

export type ThinkingFormat =
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'together'
  | 'zai'
  | 'qwen'
  | 'chat-template'
  | 'qwen-chat-template'
  | 'string-thinking'
  | 'ant-ling'

/** 与内核 KernelModelCompatInput 对应；仅出现的键会被 pi-ai 采用。 */
export interface ProviderReasoningCompat {
  thinkingFormat?: ThinkingFormat
  supportsReasoningEffort?: boolean
  requiresReasoningContentOnAssistantMessages?: boolean
  /** 该网关是否接受 role: "developer"（OpenAI 新式系统角色）；不支持须显式关掉。 */
  supportsDeveloperRole?: boolean
}

/**
 * providerReasoningCompat 需要的 provider 形状（结构性类型：Redux Provider 的子集，
 * 便于单测直接构造）。type/apiOptions 来自渲染进程完整 provider 配置。
 */
export interface ReasoningCompatProviderInput {
  id?: string
  apiHost?: string
  /** Cherry ProviderType；openai/new-api/gateway 走泛用推断。 */
  type?: string
  apiOptions?: {
    /** 用户显式声明的 developer role 支持（ApiOptionsSettings 写入 true/false）。 */
    isSupportDeveloperRole?: boolean
    /** 用户声明"该网关不支持 enable_thinking 参数"（上游既有开关）。 */
    isNotSupportEnableThinking?: boolean
  }
  /** @deprecated 顶层旧开关（migrate 已迁入 apiOptions；兜底兼容旧数据）。 */
  isNotSupportDeveloperRole?: boolean
}

export interface ReasoningProviderRule {
  /** 配置条目名（日志/排查用）。 */
  name: string
  /** 命中即视为该网关：apiHost 包含任一子串（小写比较）。 */
  hostIncludes: readonly string[]
  /** 可选：也可按 provider preset id（小写）命中。 */
  providerIds?: readonly string[]
  /** 该网关认的协议修正。 */
  compat: ProviderReasoningCompat
  /** 仅这些模型启用；缺省 = 该网关上所有模型。 */
  appliesTo?: (model: Model) => boolean
}

/**
 * 已登记网关事实（B 层）。**网关级、有官方文档背书**的修正放这里；
 * 思考开关键族的协议是模型语义而非网关事实，已由 C 层泛用处理，勿在此重复登记。
 * 新增网关 = 加一行：hostIncludes / providerIds / compat，可选 appliesTo。
 */
export const REASONING_PROVIDER_RULES: readonly ReasoningProviderRule[] = [
  {
    // 硅基流动通用修正：OpenAI 兼容端点不认 role: "developer"（只认 system），
    // pi-ai 自动探测会按 openai 新语义升级 system → developer，导致 400（code 20015）。
    // （其思考协议走 C 层：硅基流动 host 不在引擎识别名单内，键族模型自动得 qwen 格式。）
    name: 'siliconflow-base',
    hostIncludes: ['siliconflow'],
    providerIds: ['silicon'],
    compat: { supportsDeveloperRole: false }
  }
]

// ---- C 层：泛用家族推断 ----

/** pi-ai detectCompat 能自己认出的网关 host（小写子串；引擎名单，升级 pi-ai 时同步）。 */
const PI_AI_DETECTED_HOSTS: readonly string[] = [
  'api.openai.com', // 引擎默认（openai 格式）在这里定义即正确
  'deepseek.com',
  'api.z.ai',
  'open.bigmodel.cn',
  'api.together.ai',
  'api.together.xyz',
  'openrouter.ai',
  'api.moonshot.',
  'api.ant-ling.com',
  'integrate.api.nvidia.com',
  'api.x.ai',
  'cerebras.ai',
  'chutes.ai',
  'api.cloudflare.com',
  'gateway.ai.cloudflare.com',
  'opencode.ai'
]

/**
 * 不做 enable_thinking 推断的 provider：本地推理套件（上游既有黑名单，见 utils/provider.ts）
 * 与上游已知挑剔的严格网关（poe/qiniu，连 developer role 都拒）——协议交给引擎探测。
 * 注意 id 集合覆盖系统 preset id；命名冲突的自定义 id 概率可忽略。
 */
const INFER_OPTOUT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'ollama',
  'lmstudio',
  'nvidia',
  'gpustack',
  'poe',
  'qiniu'
])

/** 走 OpenAI completions 协议、可做 enable_thinking 推断的 provider 类型。 */
const ENABLE_THINKING_PROVIDER_TYPES: ReadonlySet<string> = new Set(['openai', 'new-api', 'gateway'])

/**
 * enable_thinking 开关键族：模型自带的"可关可开"思考开关语义（各家聚合网关的通行约定）。
 * R1/K2-thinking 等常开思考模型不在此列（无可开关语义，不发档位参数）。
 */
const isEnableThinkingFamily = (model: Model): boolean =>
  isDeepSeekHybridInferenceModel(model) ||
  isSupportedThinkingTokenZhipuModel(model) ||
  isSupportedThinkingTokenQwenModel(model) ||
  isSupportedThinkingTokenKimiModel(model)

/** enable_thinking 协议修正（与硅基流动真机验证过的组合逐键一致，单一代码路径）。 */
const ENABLE_THINKING_COMPAT: ProviderReasoningCompat = {
  thinkingFormat: 'qwen',
  supportsReasoningEffort: false,
  requiresReasoningContentOnAssistantMessages: true
}

function ruleMatches(rule: ReasoningProviderRule, provider: { id?: string; apiHost?: string }): boolean {
  const host = String(provider.apiHost ?? '').toLowerCase()
  const id = String(provider.id ?? '').toLowerCase()
  return (
    rule.hostIncludes.some((needle) => host.includes(needle)) ||
    (rule.providerIds?.some((needle) => id === needle) ?? false)
  )
}

/** C 层门槛：无名 OpenAI 兼容网关 × enable_thinking 键族 → 施加推断协议。 */
function genericEnableThinkingApplies(provider: ReasoningCompatProviderInput, model: Model): boolean {
  const type = String(provider.type ?? '')
  if (ENABLE_THINKING_PROVIDER_TYPES.has(type) === false) return false // ollama/anthropic/openai-response/azure 等不适用
  if (INFER_OPTOUT_PROVIDER_IDS.has(String(provider.id ?? '').toLowerCase())) return false
  const host = String(provider.apiHost ?? '').toLowerCase()
  if (PI_AI_DETECTED_HOSTS.some((needle) => host.includes(needle))) return false // 引擎识别的网关：探测优先
  return isEnableThinkingFamily(model)
}

/**
 * 给定 provider + model，返回应透传给 pi-ai 的协议 compat（B → C → A 三层，
 * 见文件头）；无剩余键 → undefined（不干预，走 pi-ai 自动探测）。
 */
export function providerReasoningCompat(
  provider: ReasoningCompatProviderInput,
  model: Model
): ProviderReasoningCompat | undefined {
  const merged: ProviderReasoningCompat = {}

  const apply = (patch: ProviderReasoningCompat): void => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      Object.assign(merged, { [key]: value })
    }
  }

  // B 层：已登记网关事实
  for (const rule of REASONING_PROVIDER_RULES) {
    if (!ruleMatches(rule, provider)) continue
    if (rule.appliesTo !== undefined && !rule.appliesTo(model)) continue
    apply(rule.compat)
  }

  // C 层：泛用家族推断（无名 OpenAI 兼容网关）
  if (genericEnableThinkingApplies(provider, model)) {
    apply(ENABLE_THINKING_COMPAT)
  }

  // A 层：用户声明（最高优先）
  if (provider.apiOptions?.isNotSupportEnableThinking === true && merged.thinkingFormat === 'qwen') {
    // 用户声明该网关不认 enable_thinking → 剥离 C 层协议，回落 pi-ai 探测。
    // 只在协议确实来自 enable_thinking 推断（qwen 格式）时剥离，不误伤其他网关事实。
    delete merged.thinkingFormat
    delete merged.supportsReasoningEffort
    delete merged.requiresReasoningContentOnAssistantMessages
  }
  if (provider.apiOptions?.isSupportDeveloperRole !== undefined) {
    // 显式声明（含 migrate 127/129/132 落进旧数据的机器值：老自定义网关一律 false）。
    // 照单全收 = 恢复上游语义：自定义网关默认不发 developer 角色（比引擎默认的"发"保守，
    // 硅基流动 400 事故即默认发的代价）；用户在 provider 设置里拨开关即可纠正。
    merged.supportsDeveloperRole = provider.apiOptions.isSupportDeveloperRole
  } else if (provider.isNotSupportDeveloperRole === true) {
    // 顶层旧旗标兜底：migrate 129 给系统 provider 清空了 apiOptions，但 poe/qiniu 的
    // 顶层 isNotSupportDeveloperRole（127 写入）仍滞留在旧数据里——不接住就是 400。
    merged.supportsDeveloperRole = false
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}
