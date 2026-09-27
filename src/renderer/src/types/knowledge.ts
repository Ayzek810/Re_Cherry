/**
 * 知识库类型（v0.3.2 按 CS_V1 全形恢复）。
 * KnowledgeReference 已于 v0.4 统一到 V1 形状（{id: number; content; sourceUrl; type; file?; metadata?}），
 * 生产方（kernel/knowledgeSearchTool 的 meta 通道）与消费方（store/messageBlock 引用卡格式化）同批切换。
 */
import type { Model } from '.'
import type { FileMetadata } from './file'

export type KnowledgeItemType = 'file' | 'url' | 'note' | 'sitemap' | 'directory' | 'memory' | 'video'

export type KnowledgeItem = {
  id: string
  baseId?: string
  uniqueId?: string
  uniqueIds?: string[]
  type: KnowledgeItemType
  content: string | FileMetadata | FileMetadata[]
  remark?: string
  created_at: number
  updated_at: number
  processingStatus?: ProcessingStatus
  processingProgress?: number
  processingError?: string
  retryCount?: number
  isPreprocessed?: boolean
}

export type KnowledgeFileItem = KnowledgeItem & {
  type: 'file'
  content: FileMetadata
}

export const isKnowledgeFileItem = (item: KnowledgeItem): item is KnowledgeFileItem => {
  return item.type === 'file'
}

export type KnowledgeVideoItem = KnowledgeItem & {
  type: 'video'
  content: FileMetadata[]
}

export const isKnowledgeVideoItem = (item: KnowledgeItem): item is KnowledgeVideoItem => {
  return item.type === 'video'
}

export type KnowledgeNoteItem = KnowledgeItem & {
  type: 'note'
  content: string
  sourceUrl?: string
}

export const isKnowledgeNoteItem = (item: KnowledgeItem): item is KnowledgeNoteItem => {
  return item.type === 'note'
}

export type KnowledgeDirectoryItem = KnowledgeItem & {
  type: 'directory'
  content: string
}

export const isKnowledgeDirectoryItem = (item: KnowledgeItem): item is KnowledgeDirectoryItem => {
  return item.type === 'directory'
}

export type KnowledgeUrlItem = KnowledgeItem & {
  type: 'url'
  content: string
}

export const isKnowledgeUrlItem = (item: KnowledgeItem): item is KnowledgeUrlItem => {
  return item.type === 'url'
}

export type KnowledgeSitemapItem = KnowledgeItem & {
  type: 'sitemap'
  content: string
}

export const isKnowledgeSitemapItem = (item: KnowledgeItem): item is KnowledgeSitemapItem => {
  return item.type === 'sitemap'
}

export type KnowledgeGeneralItem = KnowledgeItem & {
  content: string
}

export interface KnowledgeBase {
  id: string
  name: string
  model: Model
  dimensions?: number
  description?: string
  items: KnowledgeItem[]
  created_at: number
  updated_at: number
  version: number
  documentCount?: number
  chunkSize?: number
  chunkOverlap?: number
  threshold?: number
  rerankModel?: Model
  preprocessProvider?: {
    type: 'preprocess'
    provider: PreprocessProvider
  }
}

/**
 * 知识库主进程参数（v0.3.2 批次1 按 UI 骨架恢复）。
 * fork 分叉点：V1 形状含 embedApiClient/rerankApiClient（由 aiCore 构造），fork 批次1 无嵌入
 * 机制，先省略；批次4（知识库接线）落地真实 IPC 时再对齐 V1 形状。
 */
export type KnowledgeBaseParams = {
  id: string
  dimensions?: number
  chunkSize?: number
  chunkOverlap?: number
  documentCount?: number
  preprocessProvider?: {
    type: 'preprocess'
    provider: PreprocessProvider
  }
}

/** 语义检索结果（批次1 仅类型；真实检索批次4 接线）。 */
export interface KnowledgeSearchResult {
  pageContent: string
  score: number
  metadata: Record<string, any>
}

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed'

export const PreprocessProviderIds = {
  doc2x: 'doc2x',
  mistral: 'mistral',
  mineru: 'mineru',
  'open-mineru': 'open-mineru',
  paddleocr: 'paddleocr',
  /** 本地 PaddleOCR（v0.3.2 自 CS_V2 移植）：内置推理，权重按需下载，无密钥无 apiHost。 */
  'local-paddle': 'local-paddle'
} as const

export type PreprocessProviderId = keyof typeof PreprocessProviderIds

export const isPreprocessProviderId = (id: string): id is PreprocessProviderId => {
  return Object.hasOwn(PreprocessProviderIds, id)
}

export interface PreprocessProvider {
  id: PreprocessProviderId
  name: string
  apiKey?: string
  apiHost?: string
  model?: string
  options?: any
}

/** 消息投影里的知识引用（v0.4 统一到 V1 形状：types/knowledge.ts 逐字段一致）。
 *  消费方：kernelChat 建引用载体、store/messageBlock 格式化引用卡。 */
export type KnowledgeReference = {
  id: number
  content: string
  sourceUrl: string
  type: KnowledgeItemType
  file?: FileMetadata
  metadata?: Record<string, any>
}
