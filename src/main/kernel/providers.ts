import type { Context } from '@deepseek-ai/cordis'
import { type CredentialRef, credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { loggerService } from '@logger'

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

export interface KernelModelInput {
  id: string
  name?: string
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

/** provider id → 合法的 CredentialRef 名（POSIX 环境变量文法）。 */
export function credentialRefForProvider(providerId: string): CredentialRef {
  return credentialRef(`CHERRY_${providerId.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_')}`)
}

/**
 * 把渲染进程的 provider 配置同步进内核：
 * 1. apiKey 写入内存凭证服务（路由以此解析密钥）
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
        : { models: provider.models.map((model) => ({ id: model.id, name: model.name ?? model.id })) })
    }
    synced += 1
  }

  await ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: profiles })
  logger.info(`kernel: synced ${synced} provider routes to the kernel`)
}
