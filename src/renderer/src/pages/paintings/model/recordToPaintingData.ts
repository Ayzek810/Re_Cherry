/**
 * PaintingRecord → PaintingData 反序列化（v0.3.3 批次4，V2 recordToPaintingData 重写）。
 * V2 的 normalizeStoredPaintingModel（unique-model-id 剥壳）照搬——fork 的
 * modelId 也可能存成 provider:model 形态（历史数据防御）。文件解析从 DataApi
 * FileEntry 换成 Dexie 内嵌 FileMetadata（无 404 语义，直接透传）。
 */
import type { PaintingRecord } from '@renderer/types'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'

/** fork 侧没有 unique-model-id 工具，按 V2 语义手工剥 provider: 前缀。 */
export function normalizeStoredPaintingModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  // "provider/model" 或 "provider:model" 形态 → 取尾段（V2 parseUniqueModelId 等价）
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'))
  if (separatorIndex >= 0) {
    const tail = trimmed.slice(separatorIndex + 1).trim()
    if (tail) return tail
  }
  return trimmed
}

export function recordToPaintingData(record: PaintingRecord): PaintingData {
  return {
    id: record.id,
    providerId: record.providerId,
    mode: 'generate',
    model: normalizeStoredPaintingModel(record.modelId),
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
