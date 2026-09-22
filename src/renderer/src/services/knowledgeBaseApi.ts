/**
 * 知识库主进程 API（批次4 接线：批次1 替身整体换装真实 IPC）。
 *
 * 嵌入模型引用只上行 {providerId, modelId, dimensions}（fork 偏离上游的明文
 * apiKey 下行——主进程从 provider 路由快照/ProviderKeyStore 自解析，见
 * services/knowledge/embeddings.ts）；阈值过滤与 documentCount 截断在渲染层
 *（上游同语义），主进程只做单库 top documentCount 余弦检索。
 */
import { loggerService } from '@logger'
import type { KnowledgeBase, KnowledgeBaseParams, KnowledgeSearchResult } from '@renderer/types'

const logger = loggerService.withContext('KnowledgeBaseApi')

/** 嵌入模型引用（fork 偏离点：无 apiKey，主进程自解析）。 */
export interface KnowledgeEmbeddingRefPayload {
  providerId: string
  modelId: string
  dimensions?: number
}

/** 从 KnowledgeBase.model 派生嵌入引用（渲染层派生，不含密钥）。 */
export const getEmbeddingRef = (base: KnowledgeBase): KnowledgeEmbeddingRefPayload => ({
  providerId: base.model.provider,
  modelId: base.model.id,
  dimensions: base.dimensions
})

export const knowledgeBaseApi = {
  /** 创建库（打开/建 LibSQL 向量库文件；redux 侧由调用方 addBase 负责）。 */
  create: async (base: KnowledgeBaseParams): Promise<void> => {
    await window.api.knowledgeBase.create({ id: base.id })
  },

  /** 重置库（清空向量库，保留库文件）。 */
  reset: async (baseId: string): Promise<void> => {
    await window.api.knowledgeBase.reset(baseId)
  },

  /** 删除库（关句柄 + 删库目录；调用方负责 redux 侧 deleteBase）。 */
  delete: async (baseId: string): Promise<void> => {
    await window.api.knowledgeBase.delete(baseId)
  },

  /** 添加条目（extract → chunk → embed → 落库；LoaderReturn 回填 uniqueId/状态）。 */
  add: async (payload: {
    base: {
      id: string
      chunkSize?: number
      chunkOverlap?: number
      documentCount?: number
      /** 文档处理服务商 id（V2 对齐：配置即路由；主进程执行缝消费）。 */
      preprocessProviderId?: string
    }
    item:
      | { kind: 'file'; baseId: string; itemId: string; filePath: string }
      | { kind: 'url'; baseId: string; itemId: string; url: string }
      | { kind: 'note'; baseId: string; itemId: string; text: string }
    embedding: KnowledgeEmbeddingRefPayload
  }): Promise<{ entriesAdded: number; uniqueId: string; uniqueIds: string[]; loaderType: string }> => {
    return (await window.api.knowledgeBase.add(payload)) as {
      entriesAdded: number
      uniqueId: string
      uniqueIds: string[]
      loaderType: string
    }
  },

  /** 移除向量条目（按 uniqueId 整批删；条目重试 = remove + re-add）。 */
  remove: async (baseId: string, uniqueIds: string[]): Promise<void> => {
    await window.api.knowledgeBase.remove({ baseId, uniqueIds })
  }
}

/** 从 KnowledgeBase 派生主进程参数（批次4：补 embedding 引用派生入口）。 */
export const getKnowledgeBaseParams = (base: KnowledgeBase): KnowledgeBaseParams => {
  return {
    id: base.id,
    dimensions: base.dimensions,
    chunkSize: base.chunkSize,
    chunkOverlap: base.chunkOverlap,
    documentCount: base.documentCount,
    preprocessProvider: base.preprocessProvider
  }
}

/**
 * 语义检索（批次4 真实化）：主进程单库余弦检索 → 渲染层阈值过滤 + 截断。
 * 形参与上游 KnowledgeService.searchKnowledgeBase 保持一致，调用点无需改动。
 */
export const searchKnowledgeBase = async (
  query: string,
  base: KnowledgeBase,
  _rewrite?: string,
  _topicId?: string,
  _parentSpanId?: string,
  _modelName?: string
): Promise<Array<KnowledgeSearchResult & { file: null }>> => {
  try {
    const hits = (await window.api.knowledgeBase.search({
      base: {
        id: base.id,
        chunkSize: base.chunkSize,
        chunkOverlap: base.chunkOverlap,
        documentCount: base.documentCount
      },
      embedding: getEmbeddingRef(base),
      query
    })) as Array<{ pageContent: string; score: number; metadata: Record<string, unknown> }>
    const threshold = base.threshold ?? 0
    const documentCount = base.documentCount ?? 30
    return hits
      .filter((hit) => hit.score >= threshold)
      .slice(0, documentCount)
      .map((hit) => ({ pageContent: hit.pageContent, score: hit.score, metadata: hit.metadata, file: null }))
  } catch (error) {
    logger.error(
      `searchKnowledgeBase failed for base "${base.id}"`,
      error instanceof Error ? error : new Error(String(error))
    )
    return []
  }
}
