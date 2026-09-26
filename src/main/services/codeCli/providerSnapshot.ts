// fork 缝：主进程侧的 CodeMate provider 快照单例（2026-09-24，v0.3.4-1）。
// V2 用 DataApi providerService/modelService 按需查询；fork 的 provider 真源是渲染层
// redux 经 Dsh_SyncProviders 推送——与 setLightLlmProviderRoutes/knowledgeService.setProviders
// 同一投影点落一份快照，供 DeepSeekHarnessService / Hermes 服务 /（批次3）网关五函数消费。
// 含明文 apiKey：与内核 ctx.credentials 同一信任边界（主进程内存、不落盘）。

import { loggerService } from '@logger'
import type { KernelProviderInput } from '@main/kernel/providers'

const logger = loggerService.withContext('CodeMateProviderSnapshot')

let snapshot: readonly KernelProviderInput[] = []

export function setCodeMateProviders(providers: readonly KernelProviderInput[]): void {
  snapshot = providers
  logger.info(`code-mate: provider snapshot updated (${providers.length} provider(s))`)
}

export function getCodeMateProviders(): readonly KernelProviderInput[] {
  return snapshot
}

export function getCodeMateProvider(id: string): KernelProviderInput | undefined {
  return snapshot.find((provider) => provider.id === id)
}
