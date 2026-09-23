/**
 * 绘画草稿/展示态类型（v0.3.3 批次4，② 薄适配）：V2 paintingData.ts 原样保留
 * `generationStatus`/`generationError`；裁掉 `generationTaskId`/`generationProgress`
 * （fork 无 job 机制，取消走 lightImageAbort(requestId)）。`inputFiles` 从 V2 的
 * FileEntry[] 换成 fork FileMetadata[]（页面自持托盘的最终形态）。
 */
import type { FileMetadata } from '@renderer/types'

export type PaintingMode = 'generate' | 'edit'

export type PaintingGenerationStatus = 'running' | 'failed' | 'canceled'

export interface PaintingData {
  id: string
  providerId: string
  mode: PaintingMode
  model?: string
  prompt: string
  files: FileMetadata[]
  inputFiles?: FileMetadata[]
  persistedAt?: number
  generationStatus?: PaintingGenerationStatus | null
  generationError?: string | null
  /**
   * 自由参数袋（键 = PAINTING_PARAM_TABLE 的 camelCase 键）。表单把控件值写进
   * 这里；canonicalGenerate 过滤表外键并合成 customSize 后收敛为
   * PaintingGenerateRequest。空/undefined 条目不下发——服务端用默认值。
   */
  params?: Record<string, unknown>
}
