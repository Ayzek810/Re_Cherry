// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/applyContext.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点两处，已标 `// fork 缝`：
// ① import 对号：UniqueModelIdSchema/parseUniqueModelId ← fork @shared/types/uniqueModelId
//   （V2 为 @shared/data/types/model）；Model ← ./providerView 投影。
// ② claude 分支随 claudeModels.ts 整块删除（fork 保留工具无 Claude detailed models 面）；
//   resolveCliConfigApplyContext 其余逐字。

import { parseUniqueModelId, UniqueModelIdSchema } from '@shared/types/uniqueModelId'
import type { UniqueModelId } from '@shared/types/uniqueModelId'

import type { Model } from './providerView'
import type { CodeCli } from '@shared/types/codeCli'

export function parseConfiguredModelId(
  // Wide on purpose: tolerates legacy '' and corrupt dev-profile values.
  modelId: string | null | undefined
): { uniqueModelId: UniqueModelId; providerId: string; modelId: string } | null {
  const result = UniqueModelIdSchema.safeParse(modelId)
  if (!result.success) {
    return null
  }
  return { uniqueModelId: result.data, ...parseUniqueModelId(result.data) }
}

export function resolveCliConfigApplyContext(
  // fork 缝②（续）：cliTool 形参保形（调用点按位置传参；claude 臂删除后不再消费）。
  _cliTool: CodeCli,
  // fork 缝②（续）：providerId/gatewayModels 形参保形（调用点按位置传参；claude 臂删除后
  // 不再消费，下划线别名）。
  _providerId: string,
  providerConfig: { modelId?: string | null; config?: Record<string, unknown> } | undefined,
  _gatewayModels?: Map<UniqueModelId, Model>
): { modelId: UniqueModelId; providerId: string; rawModelId: string; writePrimaryModel: boolean } | null {
  // fork 缝②（续）：V2 的 sanitize 结果供 claude detailed-models 臂消费；该臂删除后本层
  // 不再读 config（deepseek 的 blob 归一在 sanitizeCliConfigBlob 写路径仍生效）。

  const parsedModelId = parseConfiguredModelId(providerConfig?.modelId)
  if (!parsedModelId) return null
  return {
    modelId: parsedModelId.uniqueModelId,
    providerId: parsedModelId.providerId,
    rawModelId: parsedModelId.modelId,
    writePrimaryModel: true
  }
}
