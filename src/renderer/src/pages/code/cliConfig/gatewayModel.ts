// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/gatewayModel.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点一处（import 对号）：isUniqueModelId/parseUniqueModelId ← ./values / fork
// @shared/types/uniqueModelId（V2 为 @shared/data/types/model）；Model ← ./providerView 投影。
// 函数体逐字。

import { formatGatewayModelId } from '@shared/utils/apiGateway'
import type { UniqueModelId } from '@shared/types/uniqueModelId'
import { parseUniqueModelId } from '@shared/types/uniqueModelId'

import { isUniqueModelId } from './values'
import type { Model } from './providerView'

/**
 * The gateway-addressed model string ("providerId:apiModelId") for a stored real `UniqueModelId`,
 * used by the connection-match sides so the value they compare against a written config is identical
 * to what {@link resolveContext} writes. Pass the model's `apiModelId` (from the model record) when
 * available; falls back to the raw model id. Returns `undefined` for a missing/invalid id or a
 * non-gateway-routable model, so the matcher simply skips the model check rather than throwing.
 */
export function gatewayExpectedModel(
  uniqueModelId: string | null | undefined,
  apiModelId?: string
): string | undefined {
  if (!uniqueModelId || !isUniqueModelId(uniqueModelId)) return undefined
  const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
  try {
    return formatGatewayModelId(providerId, apiModelId ?? modelId)
  } catch {
    return undefined
  }
}

/**
 * Reverse of {@link gatewayExpectedModel}: given a gateway address ("providerId:apiModelId")
 * parsed from a raw config file, find the enabled model's `UniqueModelId` that addresses to it.
 * Used when the gateway provider has no model selected yet but the user hand-edited a model into
 * the raw file — so the edit resolves to a real model instead of being silently dropped. Returns
 * `undefined` when no enabled model matches (the caller then persists the draft as foreign).
 */
export function gatewayModelIdFromAddress(
  gatewayAddress: string | null | undefined,
  models: Map<UniqueModelId, Model> | undefined
): UniqueModelId | undefined {
  if (!gatewayAddress || !models) return undefined
  for (const [uniqueModelId, model] of models) {
    if (gatewayExpectedModel(uniqueModelId, model.apiModelId) === gatewayAddress) {
      return uniqueModelId
    }
  }
  return undefined
}
