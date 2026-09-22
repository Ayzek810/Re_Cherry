/**
 * 知识库类型（v0.3.2 按 CS_V1 全形恢复）。
 * fork 分叉点：`KnowledgeReference` 保持 fork 消息投影形状（{id: string; source: string; content: string}，
 * 被 newMessage/chunk/index 的消息块消费）——V1 形状（{id: number; sourceUrl; type; file?; metadata?}）
 * 在批次4（知识库接线）落地 Citation knowledge 分支时统一，届时两处消费方同批切换。
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

/** 消息投影里的知识引用（fork 现状形状，消费方见文件头注释；V1 形状批次4 统一时切换）。 */
export type KnowledgeReference = {
  id: string
  source: string
  content: string
}
