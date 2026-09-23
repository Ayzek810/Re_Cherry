/**
 * PaintingData ↔ PaintingRecord 双向 mapper（v0.3.3 批次4）。
 * V2 paintingDataToCreateDto/paintingDataToUpdateDto 合并重写：持久化目标从
 * DataApi DTO 换成 Dexie PaintingRecord 行（v16 paintings 表，FileMetadata[]
 * 直接内嵌，不再走 id 间接层——缝反转消失，见任务 #8 处置）。
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
      ...(painting.params ?? {}),
      imageSize: (painting.params?.imageSize as string) ?? '1024x1024',
      batchSize: (painting.params?.batchSize as number) ?? 1
    } as PaintingRecord['params'],
    output: painting.files,
    input: painting.inputFiles ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
}

/** Dexie 行 → PaintingData（历史条目/草稿回灌；mode 是活表单态，缺省 generate）。 */
export function recordToPaintingData(record: PaintingRecord): PaintingData {
  return {
    id: record.id,
    providerId: record.providerId,
    mode: 'generate',
    model: record.modelId || undefined,
    prompt: record.prompt,
    files: record.output ?? [],
    inputFiles: record.input ?? [],
    persistedAt: record.createdAt,
    params: { ...(record.params ?? {}) } as PaintingData['params']
  }
}

export function recordsToPaintingDataList(records: PaintingRecord[]): PaintingData[] {
  return records.map(recordToPaintingData)
}
