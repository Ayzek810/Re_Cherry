// fork 缝：V2 的 UniqueModelId（src/shared/data/types/model.ts 内）未随 Model 宇宙整体移植，
// 此处落最小语义面："providerId::modelId"（双冒号分隔，modelId 段可含单冒号）。
// zod schema 随包内 zod 4 提供（fork 已有 zod@4.1.5）。

import { z } from 'zod'

declare const brand: unique symbol
export type UniqueModelId = string & { readonly [brand]: 'UniqueModelId' }

export const UniqueModelIdSchema = z
  .string()
  .regex(/^[^:]+::.+$/, 'Expected "providerId::modelId"')
  .transform((value) => value as UniqueModelId)

export function parseUniqueModelId(id: UniqueModelId): { providerId: string; modelId: string } {
  const index = id.indexOf('::')
  return { providerId: id.slice(0, index), modelId: id.slice(index + 2) }
}
