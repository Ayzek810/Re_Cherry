// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/values.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：函数面按 hermes 依赖闭包裁剪——cliProviderKeyName / omitKeysByPrefix /
// isCherryManagedModel / findCherryProviderKey / dropFeatureGoalsIfEmpty /
// dropSecurityAuthSelectedTypeIfEmpty / numberValue / sanitizeProviderName 再导出随对应
// adapter 整块删除。isUniqueModelId / createUniqueModelId 在 V2 位于
// @shared/data/types/model.ts L146-188，fork 不触碰 packages/shared/types/uniqueModelId
//（本批触碰清单外），此处按 V2 原文逐字落盘。

import type { UniqueModelId } from '@shared/types/uniqueModelId'

// fork 缝：V2 @shared/data/types/model.ts L132-133 逐字（createUniqueModelId 的守卫面）。
const UNIQUE_MODEL_ID_SEPARATOR = '::'
const RESERVED_UNIQUE_MODEL_ID_ROUTE_CHARS = ['?', '#'] as const

// fork 缝：V2 src/shared/data/types/model.ts L146-148 逐字（句法判定，宽松）。
export function isUniqueModelId(value: unknown): value is UniqueModelId {
  return typeof value === 'string' && value.includes(UNIQUE_MODEL_ID_SEPARATOR)
}

// fork 缝：V2 src/shared/data/types/model.ts L173-188 逐字。
export function createUniqueModelId(providerId: string, modelId: string): UniqueModelId {
  if (providerId.length === 0) {
    throw new Error('providerId cannot be empty')
  }
  if (providerId.includes(UNIQUE_MODEL_ID_SEPARATOR)) {
    throw new Error(`providerId cannot contain "${UNIQUE_MODEL_ID_SEPARATOR}": ${providerId}`)
  }
  if (modelId.length === 0) {
    throw new Error('modelId cannot be empty')
  }
  const reservedChar = RESERVED_UNIQUE_MODEL_ID_ROUTE_CHARS.find((char) => modelId.includes(char))
  if (reservedChar) {
    throw new Error(`modelId cannot contain reserved route character "${reservedChar}": ${modelId}`)
  }
  // fork 缝：V2 的 UniqueModelId 为模板串字面量类型（赋值即收窄）；fork 为品牌化 string，
  // 运行时形状一致，此处断言收窄。
  return `${providerId}${UNIQUE_MODEL_ID_SEPARATOR}${modelId}` as UniqueModelId
}

/**
 * Non-throwing `createUniqueModelId` for render/event paths fed by user input
 * (raw config files, Claude detailed env values): empty parts or reserved
 * route characters yield `undefined` instead of a render-time throw.
 */
export function safeCreateUniqueModelId(providerId: string, modelId: string): UniqueModelId | undefined {
  try {
    return createUniqueModelId(providerId, modelId)
  } catch {
    return undefined
  }
}

export function firstApiKey(keys: Array<{ key: string; isEnabled: boolean }> | undefined): string {
  return keys?.find((k) => k.isEnabled)?.key ?? ''
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {}
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeUrl(value: string | undefined): string {
  return value ? value.trim().replace(/\/+$/, '') : ''
}
