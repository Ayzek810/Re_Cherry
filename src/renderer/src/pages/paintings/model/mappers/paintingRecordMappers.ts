/**
 * PaintingData → PaintingRecord 单向 mapper（v0.3.3 批次4）。
 * V2 paintingDataToCreateDto/paintingDataToUpdateDto 合并重写：持久化目标从
 * DataApi DTO 换成 Dexie PaintingRecord 行（v16 paintings 表，FileMetadata[]
 * 直接内嵌，不再走 id 间接层——缝反转消失，见任务 #8 处置）。
 * 反序列化（Dexie 行 → PaintingData）在 `model/recordToPaintingData.ts`，
 * 它做 `normalizeStoredPaintingModel` 剥壳；两份实现并存曾让"历史画作打不开"随时可踩（f2-30）。
 */
import type { PaintingRecord } from '@renderer/types'
import { v4 as uuid } from 'uuid'

import type { PaintingData } from '../types/paintingData'

/** PaintingData → Dexie 行（create：补 id/时间戳；update：沿用原 id/createdAt）。 */
export function paintingDataToRecord(
  painting: PaintingData,
  existing?: Pick<PaintingRecord, 'id' | 'createdAt'>
): PaintingRecord {
  const now = Date.now()
  return {
    id: existing?.id ?? painting.id ?? uuid(),
    providerId: painting.providerId,
    modelId: painting.model?.trim() || '',
    prompt: painting.prompt,
    params: {
      prompt: painting.prompt,
      ...painting.params,
      // v0.3.3 批次6：canonical 键名统一为 V2 的 `size`/`numImages`（旧行里的
      // imageSize/batchSize 由 canonicalGenerate 的 LEGACY_PARAM_ALIASES 读时兼容）。
      size: (painting.params?.size as string) ?? '1024x1024',
      numImages: (painting.params?.numImages as number) ?? 1
    } as PaintingRecord['params'],
    output: painting.files,
    input: painting.inputFiles ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
}

// 二轮审查 f2-30：本文件曾另有一份 `recordToPaintingData` / `recordsToPaintingDataList`，
// 与 `model/recordToPaintingData.ts` 同形但差一行——那一行是语义性的：这里写的是
// `model: record.modelId || undefined`，**不**归一化 `provider:model` / `provider/model` 前缀。
// 历史行若存成带前缀形态，用错一份就会把 `provider:model` 当成模型 id，
// `usePaintingModelCatalog` 匹配不到，最终被 `usePaintingGenerationGuard` 判成 `model_unavailable`。
// 反序列化只保留归一化版本（`@renderer/pages/paintings/model/recordToPaintingData`），
// 本文件只负责正向 `paintingDataToRecord`。
