import type { Context } from '@deepseek-ai/cordis'
import { type CredentialRef, credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { loggerService } from '@logger'
import { KERNEL_REASONING_LEVELS } from '@shared/config/reasoning'

import { clearModelCapabilityCache } from './topics'

const logger = loggerService.withContext('KernelProviders')

/** 渲染进程推送的 provider 配置的最小形状（来自 Redux llm.providers）。 */
export interface KernelProviderInput {
  id: string
  type: string
  name?: string
  apiKey?: string
  apiHost?: string
  models?: KernelModelInput[]
  enabled?: boolean
}

/**
 * 可透传给 pi-ai 的 per-model 兼容覆盖（引擎 getCompat：仅出现的键覆盖自动探测）。
 * Re_Cherry 用它修正第三方网关的思考参数语义（如硅基流动 DeepSeek/Zhipu 用 enable_thinking）。
 */
export interface KernelModelCompatInput {
  thinkingFormat?:
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
  supportsReasoningEffort?: boolean
  requiresReasoningContentOnAssistantMessages?: boolean
}

export interface KernelModelInput {
  id: string
  name?: string
  /**
   * 该模型可声明的思考档位（pi-ai reasoningEfforts：档位 → wire 拼写，off 为 null）。
   * 渲染进程按模型家族生成；缺省表示不声明（保留 pi-ai 目录能力）。
   */
  reasoningEfforts?: Record<string, string | null>
  /** 渲染进程按 provider 端点/模型家族给出的思考协议修正（缺省走 pi-ai 自动探测）。 */
  compat?: KernelModelCompatInput
}

/**
 * Cherry provider 类型 → pi-ai 手写路由协议。
 * 覆盖三种线路协议；其余类型（gemini/azure/vertex/bedrock 等）暂不支持，跳过并告警。
 */
const PROTOCOL_BY_TYPE: Record<string, string> = {
  openai: 'openai-completions',
  'openai-response': 'openai-responses',
  anthropic: 'anthropic-messages',
  'new-api': 'openai-completions',
  gateway: 'openai-completions',
  ollama: 'openai-completions',
  mistral: 'openai-completions'
}

/**
 * 卫生化渲染进程声明的思考能力字典：
 * 只保留合法档位键与合法 wire 值（off 用 null），且必须至少含一个非 off 档位，
 * 否则返回 undefined（不声明，走 pi-ai 目录默认），避免一条坏声明拖垮整个 provider 路由。
 */
function sanitizeReasoningEfforts(
  input: Record<string, string | null> | undefined
): Record<string, string | null> | undefined {
  if (input === undefined) return undefined
  const dict: Record<string, string | null> = {}
  let hasPositiveLevel = false
  for (const [level, value] of Object.entries(input)) {
    if (!KERNEL_REASONING_LEVELS.includes(level as (typeof KERNEL_REASONING_LEVELS)[number])) continue
    if (level === 'off') {
      if (value === null) dict.off = null
      continue
    }
    if (typeof value !== 'string' || value.length === 0) continue
    dict[level] = value
    hasPositiveLevel = true
  }
  return hasPositiveLevel ? dict : undefined
}

/** provider id → 合法的 CredentialRef 名（POSIX 环境变量文法）。 */
export function credentialRefForProvider(providerId: string): CredentialRef {
  return credentialRef(`CHERRY_${providerId.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_')}`)
}

/**
 * 把渲染进程的 provider 配置同步进内核：
 * 1. apiKey（可为逗号拼接的多 key）写入内存凭证服务，由凭证层切分并逐请求轮换
 * 2. provider 路由写进 `llm-pi-ai` settings 段，插件 watcher 触发重新注册
 * 不支持的 provider 类型跳过并告警，不影响其余路由。
 */
export async function syncCherryProviders(ctx: Context, providers: readonly KernelProviderInput[]): Promise<void> {
  const profiles: Record<string, object> = {}
  let synced = 0

  for (const provider of providers) {
    if (provider.enabled === false) continue
    const protocol = PROTOCOL_BY_TYPE[provider.type]
    if (protocol === undefined) {
      logger.warn(`kernel: provider "${provider.id}" (type ${provider.type}) is not supported by the kernel yet`)
      continue
    }
    if (provider.apiKey === undefined || provider.apiKey.length === 0) {
      logger.warn(`kernel: provider "${provider.id}" has no apiKey, skipped`)
      continue
    }
    const ref = credentialRefForProvider(provider.id)
    await ctx.credentials.set(ref, provider.apiKey)
    profiles[provider.id] = {
      apiKeyEnv: ref,
      ...(provider.name === undefined ? {} : { displayName: provider.name }),
      api: protocol,
      ...(provider.apiHost === undefined ? {} : { baseURL: provider.apiHost }),
      ...(provider.models === undefined || provider.models.length === 0
        ? {}
        : {
            models: provider.models.map((model) => {
              const reasoningEfforts = sanitizeReasoningEfforts(model.reasoningEfforts)
              return {
                id: model.id,
                name: model.name ?? model.id,
                ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
                ...(model.compat === undefined ? {} : { compat: model.compat })
              }
            })
          })
    }
    synced += 1
  }

  const ns = settingsNamespace('llm-pi-ai')

  // dsh-settings 的 update 是 merge 语义：删掉的 provider/端点不会自动消失，
  // 旧 route 会残留（含其 apiKeyEnv，继续占用凭证名）。先按 diff 清理不再存在的键。
  const section = ctx.settings.get(ns) as { providers?: Record<string, unknown> } | undefined
  const previousKeys = section?.providers === undefined ? [] : Object.keys(section.providers)
  const staleKeys = previousKeys.filter((key) => !(key in profiles))
  if (staleKeys.length > 0) {
    await ctx.settings.mutate(
      ns,
      staleKeys.map((key) => ({ op: 'unset', path: ['providers', key] }))
    )
    for (const key of staleKeys) {
      await ctx.credentials.unset(credentialRefForProvider(key)).catch(() => void 0)
    }
    logger.info(`kernel: removed ${staleKeys.length} stale provider route(s): ${staleKeys.join(', ')}`)
  }

  await ctx.settings.update(ns, { providers: profiles })
  clearModelCapabilityCache()
  logger.info(`kernel: synced ${synced} provider routes to the kernel`)
}
